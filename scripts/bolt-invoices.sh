#!/usr/bin/env bash
# bolt-invoices.sh - Process Bolt Work Profile reports and forward invoices
# Uses gws (Google Workspace CLI) for Gmail operations
# Searches for new Bolt Business emails, downloads invoice PDFs, sends to accounting

set -euo pipefail

ACCOUNT="ugis.springis@gmail.com"
RECIPIENT="ugis.springis@proofit.lv"
PROCESSED_FILE="/home/uspringis/clawd/scripts/.bolt-processed-ids"
WORK_DIR="/tmp/bolt-invoices-$$"

# Create processed file if it doesn't exist
touch "$PROCESSED_FILE"

# Cleanup function
cleanup() {
    rm -rf "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Search for Bolt Business Work Profile reports
echo "Searching for Bolt Work Profile reports..."
SEARCH_OUTPUT=$(gws gmail users messages list --params "{\"userId\": \"me\", \"q\": \"from:global@bolt.eu subject:\\\"Work Profile report\\\"\", \"maxResults\": 10}" 2>/dev/null || true)

if [ -z "$SEARCH_OUTPUT" ] || ! echo "$SEARCH_OUTPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('messages') else 1)" 2>/dev/null; then
    echo "No Bolt Work Profile reports found"
    exit 0
fi

# Parse message IDs
MSG_IDS=$(echo "$SEARCH_OUTPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(m['id']) for m in d.get('messages',[])]" 2>/dev/null || true)

if [ -z "$MSG_IDS" ]; then
    echo "No message IDs found"
    exit 0
fi

for MSG_ID in $MSG_IDS; do
    # Skip if already processed
    if grep -q "^${MSG_ID}$" "$PROCESSED_FILE" 2>/dev/null; then
        echo "Skipping already processed: $MSG_ID"
        continue
    fi

    echo "Processing email: $MSG_ID"
    
    # Create working directory
    rm -rf "$WORK_DIR" 2>/dev/null || true
    mkdir -p "$WORK_DIR/pdfs"
    
    # Get email metadata and attachment info
    EMAIL_JSON=$(gws gmail users messages get --params "{\"userId\": \"me\", \"id\": \"$MSG_ID\", \"format\": \"full\"}" 2>/dev/null || true)
    
    if [ -z "$EMAIL_JSON" ]; then
        echo "Failed to fetch email $MSG_ID"
        continue
    fi
    
    # Extract subject and attachment info using Python
    eval "$(echo "$EMAIL_JSON" | python3 -c "
import json, sys, shlex
msg = json.load(sys.stdin)
# Extract subject
headers = msg.get('payload',{}).get('headers',[])
subject = next((h['value'] for h in headers if h['name'].lower()=='subject'), 'Bolt Work Profile Report')
print(f'SUBJECT={shlex.quote(subject)}')
# Find CSV attachment
def find_attachments(payload):
    results = []
    if 'parts' in payload:
        for p in payload['parts']:
            results.extend(find_attachments(p))
    fn = payload.get('filename','')
    body = payload.get('body',{})
    aid = body.get('attachmentId','')
    if fn and aid:
        results.append((fn, aid))
    return results
attachments = find_attachments(msg.get('payload',{}))
if attachments:
    print(f'ATTACHMENT_ID={shlex.quote(attachments[0][1])}')
    print(f'ATTACHMENT_NAME={shlex.quote(attachments[0][0])}')
else:
    print('ATTACHMENT_ID=')
" 2>/dev/null)"
    
    if [ -z "${ATTACHMENT_ID:-}" ]; then
        echo "No attachment found in email $MSG_ID"
        echo "$MSG_ID" >> "$PROCESSED_FILE"
        continue
    fi
    
    # Download CSV attachment
    CSV_FILE="$WORK_DIR/report.csv"
    gws gmail users messages attachments get --params "{\"userId\": \"me\", \"messageId\": \"$MSG_ID\", \"id\": \"$ATTACHMENT_ID\"}" 2>/dev/null | python3 -c "
import json, sys, base64
data = json.load(sys.stdin)
# Gmail uses URL-safe base64
raw = data.get('data','')
# Fix URL-safe base64
raw = raw.replace('-','+').replace('_','/')
decoded = base64.b64decode(raw + '==')
sys.stdout.buffer.write(decoded)
" > "$CSV_FILE" 2>/dev/null || {
        echo "Failed to download CSV attachment"
        continue
    }
    
    if [ ! -s "$CSV_FILE" ]; then
        echo "CSV file empty after download"
        continue
    fi
    
    # Extract invoice links using Python
    python3 -c "
import csv
import sys
try:
    with open('$CSV_FILE', 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            link = row.get('user_invoice_link', '').strip()
            if link and link.startswith('http'):
                print(link)
except Exception as e:
    sys.stderr.write(f'CSV parse error: {e}\n')
" > "$WORK_DIR/links.txt" 2>/dev/null || true
    
    if [ ! -s "$WORK_DIR/links.txt" ]; then
        echo "No invoice links found in CSV"
        echo "$MSG_ID" >> "$PROCESSED_FILE"
        continue
    fi
    
    # Count links found
    LINK_COUNT=$(wc -l < "$WORK_DIR/links.txt")
    echo "Found $LINK_COUNT invoice links"
    
    # Download each invoice PDF
    COUNTER=0
    while read -r LINK; do
        if [ -n "$LINK" ]; then
            COUNTER=$((COUNTER + 1))
            PDF_FILE="$WORK_DIR/pdfs/invoice_${COUNTER}.pdf"
            echo "Downloading invoice $COUNTER..."
            if curl -sL "$LINK" -o "$PDF_FILE"; then
                if file "$PDF_FILE" | grep -q "PDF"; then
                    echo "  OK: invoice_${COUNTER}.pdf"
                else
                    echo "  Not a valid PDF, removing"
                    rm -f "$PDF_FILE"
                fi
            else
                echo "  Failed to download"
            fi
        fi
    done < "$WORK_DIR/links.txt"
    
    # Count downloaded PDFs
    PDF_COUNT=$(find "$WORK_DIR/pdfs" -name "*.pdf" -type f 2>/dev/null | wc -l)
    
    if [ "$PDF_COUNT" -eq 0 ]; then
        echo "No valid PDFs downloaded"
        echo "$MSG_ID" >> "$PROCESSED_FILE"
        continue
    fi
    
    echo "Downloaded $PDF_COUNT invoices"
    
    # Build MIME email with attachments and send via gws
    echo "Sending $PDF_COUNT invoices to $RECIPIENT..."
    python3 -c "
import email.mime.multipart
import email.mime.text
import email.mime.application
import base64
import json
import glob
import os
import subprocess
import sys

msg = email.mime.multipart.MIMEMultipart()
msg['To'] = '$RECIPIENT'
msg['Subject'] = 'Bolt Invoices: $SUBJECT'

body = '''Bolt Business invoices from: $SUBJECT

Attached: $PDF_COUNT invoice PDF(s)

This is an automated message forwarded by Axion.
'''
msg.attach(email.mime.text.MIMEText(body, 'plain'))

for pdf_path in sorted(glob.glob('$WORK_DIR/pdfs/*.pdf')):
    with open(pdf_path, 'rb') as f:
        part = email.mime.application.MIMEApplication(f.read(), _subtype='pdf')
        part.add_header('Content-Disposition', 'attachment', filename=os.path.basename(pdf_path))
        msg.attach(part)

raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
payload = json.dumps({'raw': raw})

result = subprocess.run(
    ['gws', 'gmail', 'users', 'messages', 'send', '--params', '{\"userId\": \"me\"}', '--json', payload],
    capture_output=True, text=True
)
if result.returncode == 0:
    print('SUCCESS')
else:
    print(f'FAILED: {result.stderr}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null && {
        echo "Successfully sent invoices to $RECIPIENT"
        echo "$MSG_ID" >> "$PROCESSED_FILE"
    } || {
        echo "Failed to send email"
    }
done

echo "Done processing Bolt invoices"
