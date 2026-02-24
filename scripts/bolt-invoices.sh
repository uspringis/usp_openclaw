#!/usr/bin/env bash
# bolt-invoices.sh - Process Bolt Work Profile reports and forward invoices
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
SEARCH_OUTPUT=$(gog gmail messages search "from:global@bolt.eu subject:\"Work Profile report\"" --max 10 --account "$ACCOUNT" --plain 2>/dev/null || true)

if [ -z "$SEARCH_OUTPUT" ]; then
    echo "No Bolt Work Profile reports found"
    exit 0
fi

# Parse message IDs from search output (skip header line)
MSG_IDS=$(echo "$SEARCH_OUTPUT" | tail -n +2 | awk '{print $1}' | grep -v '^$' || true)

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
    
    # Get email in plain format to extract attachment info
    EMAIL_PLAIN=$(gog gmail get "$MSG_ID" --account "$ACCOUNT" 2>/dev/null || true)
    
    # Extract subject
    SUBJECT=$(echo "$EMAIL_PLAIN" | grep '^subject' | head -1 | cut -f2-)
    [ -z "$SUBJECT" ] && SUBJECT="Bolt Work Profile Report"
    
    # Extract attachment line (format: attachment<tab>filename<tab>size<tab>mime<tab>attachmentId)
    ATTACHMENT_LINE=$(echo "$EMAIL_PLAIN" | grep '^attachment' | head -1)
    
    if [ -z "$ATTACHMENT_LINE" ]; then
        echo "No attachment found in email $MSG_ID"
        echo "$MSG_ID" >> "$PROCESSED_FILE"
        continue
    fi
    
    # Extract attachment ID (last field)
    ATTACHMENT_ID=$(echo "$ATTACHMENT_LINE" | awk -F'\t' '{print $NF}')
    
    if [ -z "$ATTACHMENT_ID" ]; then
        echo "Could not extract attachment ID"
        echo "$MSG_ID" >> "$PROCESSED_FILE"
        continue
    fi
    
    # Download CSV attachment
    CSV_FILE="$WORK_DIR/report.csv"
    gog gmail attachment "$MSG_ID" "$ATTACHMENT_ID" --out "$CSV_FILE" --account "$ACCOUNT" >/dev/null 2>&1 || {
        echo "Failed to download CSV attachment"
        continue
    }
    
    if [ ! -f "$CSV_FILE" ]; then
        echo "CSV file not found after download"
        continue
    fi
    
    # Extract invoice links using Python (handles quoted CSV fields properly)
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
                # Verify it's a PDF
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
    
    # Create email body file
    cat > "$WORK_DIR/body.txt" << EOF
Bolt Business invoices from: $SUBJECT

Attached: $PDF_COUNT invoice PDF(s)

This is an automated message forwarded by Axion.
EOF
    
    # Build attachment arguments
    ATTACH_ARGS=""
    for PDF in "$WORK_DIR/pdfs"/*.pdf; do
        if [ -f "$PDF" ]; then
            ATTACH_ARGS="$ATTACH_ARGS --attach $PDF"
        fi
    done
    
    # Send email with attachments
    echo "Sending $PDF_COUNT invoices to $RECIPIENT..."
    if eval gog gmail send --to "$RECIPIENT" --subject "\"Bolt Invoices: $SUBJECT\"" --body-file "$WORK_DIR/body.txt" $ATTACH_ARGS --account "$ACCOUNT" --force; then
        echo "Successfully sent invoices to $RECIPIENT"
        echo "$MSG_ID" >> "$PROCESSED_FILE"
    else
        echo "Failed to send email"
    fi
done

echo "Done processing Bolt invoices"
