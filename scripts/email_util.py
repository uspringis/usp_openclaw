#!/usr/bin/env python3
"""
Exchange email & calendar utility
Usage:
  email_util.py check              - Check inbox (unread count + recent)
  email_util.py read [N]           - Read last N unread emails (default 5)
  email_util.py send TO SUBJ BODY  - Send email
  email_util.py search QUERY       - Search emails
  email_util.py calendar [DAYS]    - Show calendar (default today, or next N days)
  email_util.py pending [DAYS]     - Show pending/unconfirmed meetings (default 30 days)
  email_util.py freebusy EMAIL [DAYS] - Check free/busy time
  email_util.py meeting SUBJ "YYYY-MM-DD HH:MM" DURATION_MIN EMAIL1,EMAIL2 [BODY] - Create meeting
  email_util.py delete YYYY-MM-DD [SUBJECT_SEARCH] - Delete meeting by date (and optional subject)
  email_util.py add-attendee YYYY-MM-DD SUBJECT_SEARCH EMAIL1,EMAIL2 - Add attendees to existing meeting
  email_util.py remove-attendee YYYY-MM-DD SUBJECT_SEARCH EMAIL1,EMAIL2 - Remove attendees from meeting
"""

import sys
import warnings
from datetime import datetime, timedelta

warnings.filterwarnings('ignore')

from exchangelib import (
    Credentials, Account, Configuration, DELEGATE, Message, Mailbox, HTMLBody
)
from exchangelib.protocol import BaseProtocol, NoVerifyHTTPAdapter

# Allow self-signed certs (common in corporate environments)
BaseProtocol.HTTP_ADAPTER_CLS = NoVerifyHTTPAdapter

# ============================================================
# CONFIGURATION - EDIT THESE VALUES
# ============================================================
EMAIL = 'Ugis.Springis@proofit.lv'    # Your full email address
SERVER = 'services.proofit.lv'            # Exchange server hostname
DOMAIN = 'PROOFIT'                    # Windows domain name
USERNAME = 'uspringis'                 # Your Windows username (without domain)
PASSWORD = '[EWS_PASSWORD]'                 # Your password  <-- EDIT THIS
TIMEZONE = 'Europe/Riga'              # Your timezone
# ============================================================

def get_account():
    credentials = Credentials(
        username=f'{DOMAIN}\\{USERNAME}',
        password=PASSWORD
    )
    config = Configuration(server=SERVER, credentials=credentials)
    return Account(
        primary_smtp_address=EMAIL,
        config=config,
        autodiscover=False,
        access_type=DELEGATE
    )

def check_inbox():
    """Quick inbox status"""
    account = get_account()
    inbox = account.inbox
    print(f"Inbox: {inbox.total_count} total, {inbox.unread_count} unread")
    
    if inbox.unread_count > 0:
        print("\nRecent unread:")
        for item in inbox.filter(is_read=False).order_by('-datetime_received')[:5]:
            sender = item.sender.email_address if item.sender else "?"
            date = item.datetime_received.strftime('%d.%m %H:%M') if item.datetime_received else "?"
            subj = (item.subject[:50] + '...') if item.subject and len(item.subject) > 50 else (item.subject or "(no subject)")
            print(f"  * [{date}] {sender}: {subj}")

def read_emails(count=5):
    """Read unread emails with content"""
    account = get_account()
    print(f"Last {count} unread messages:\n")
    
    for i, item in enumerate(account.inbox.filter(is_read=False).order_by('-datetime_received')[:count], 1):
        sender = item.sender.email_address if item.sender else "?"
        date = item.datetime_received.strftime('%d.%m.%Y %H:%M') if item.datetime_received else "?"
        
        print("=" * 60)
        print(f"#{i} | {date}")
        print(f"From: {sender}")
        print(f"Subject: {item.subject or '(none)'}")
        print("-" * 60)
        
        body = item.text_body or item.body or ""
        if body:
            body = str(body)[:1000]
            if len(str(item.body or "")) > 1000:
                body += "\n[... truncated ...]"
        print(body or "(empty)")
        print()

def send_email(to, subject, body):
    """Send an email"""
    account = get_account()
    msg = Message(
        account=account,
        subject=subject,
        body=body,
        to_recipients=[Mailbox(email_address=to)]
    )
    msg.send()
    print(f"Sent to: {to}")

def search_emails(query, count=10):
    """Search emails by subject/sender"""
    account = get_account()
    print(f"Searching: '{query}'\n")
    
    from exchangelib import Q
    results = account.inbox.filter(
        Q(subject__icontains=query) | Q(sender__email_address__icontains=query)
    ).order_by('-datetime_received')[:count]
    
    for i, item in enumerate(results, 1):
        sender = item.sender.email_address if item.sender else "?"
        date = item.datetime_received.strftime('%d.%m %H:%M') if item.datetime_received else "?"
        subj = (item.subject[:45] + '...') if item.subject and len(item.subject) > 45 else (item.subject or "(none)")
        read = "o" if not item.is_read else "*"
        print(f"{read} [{date}] {sender}: {subj}")

def show_calendar(days=1):
    """Show calendar events (including recurring)"""
    from exchangelib import EWSDateTime, EWSTimeZone
    
    account = get_account()
    tz = EWSTimeZone(TIMEZONE)
    
    now = datetime.now()
    start_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_date = start_date + timedelta(days=days)
    
    start = EWSDateTime(start_date.year, start_date.month, start_date.day, 0, 0, 0, tzinfo=tz)
    end = EWSDateTime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=tz)
    
    if days == 1:
        print(f"Today's calendar ({now.strftime('%d.%m.%Y')}):\n")
    else:
        print(f"Calendar ({now.strftime('%d.%m')} - {end_date.strftime('%d.%m.%Y')}):\n")
    
    items = list(account.calendar.view(start=start, end=end))
    
    for item in items:
        item_start = item.start.astimezone(tz)
        item_end = item.end.astimezone(tz)
        st = item_start.strftime('%H:%M')
        en = item_end.strftime('%H:%M')
        loc = f" @ {item.location}" if item.location else ""
        is_recurring = item.recurrence or getattr(item, 'is_recurring', False)
        recurring_mark = " [recurring]" if is_recurring else ""
        print(f"  * {st}-{en}: {item.subject}{loc}{recurring_mark}")
    
    if not items:
        print("(No events)")

def show_pending(days=30):
    """Show pending/unconfirmed calendar invitations"""
    from exchangelib import EWSDateTime, EWSTimeZone
    
    account = get_account()
    tz = EWSTimeZone(TIMEZONE)
    
    now = datetime.now()
    end_date = now + timedelta(days=days)
    
    start = EWSDateTime(now.year, now.month, now.day, 0, 0, 0, tzinfo=tz)
    end = EWSDateTime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=tz)
    
    print(f"Pending calendar items (next {days} days):\n")
    
    items = account.calendar.filter(start__lt=end, end__gt=start).order_by('start')
    
    pending = []
    for item in items:
        status = getattr(item, 'my_response_type', None)
        
        # Skip if user is organizer or already responded
        if status in ['Organizer', 'Accept', 'Decline']:
            continue
        
        # Check if user is the organizer by email
        organizer = getattr(item, 'organizer', None)
        if organizer:
            org_email = getattr(organizer, 'email_address', '') or ''
            if org_email.lower() == EMAIL.lower():
                continue
        
        st = item.start.astimezone(tz).strftime('%d.%m %H:%M') if item.start else "?"
        pending.append((st, item.subject))
    
    if pending:
        for st, subj in pending:
            print(f"  ? [{st}] {subj[:45]}")
        print(f"\nTotal: {len(pending)} pending")
    else:
        print("All items confirmed!")

def show_freebusy(email, days_offset=1):
    """Show someone's free/busy time via EWS SOAP request"""
    from xml.etree import ElementTree as ET
    import requests
    from requests_ntlm import HttpNtlmAuth
    
    target_date = datetime.now() + timedelta(days=days_offset)
    start_date = target_date.replace(hour=8, minute=0, second=0, microsecond=0)
    end_date = target_date.replace(hour=18, minute=0, second=0, microsecond=0)
    
    print(f"{email} availability on {target_date.strftime('%d.%m.%Y')} (08:00-18:00):\n")
    
    try:
        # Europe/Riga timezone: UTC+2 (winter) / UTC+3 (summer DST)
        # DST starts: Last Sunday of March at 03:00
        # DST ends: Last Sunday of October at 04:00
        soap_request = f'''<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013"/>
  </soap:Header>
  <soap:Body>
    <m:GetUserAvailabilityRequest>
      <t:TimeZone>
        <t:Bias>-120</t:Bias>
        <t:StandardTime><t:Bias>0</t:Bias><t:Time>04:00:00</t:Time><t:DayOrder>5</t:DayOrder><t:Month>10</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:StandardTime>
        <t:DaylightTime><t:Bias>-60</t:Bias><t:Time>03:00:00</t:Time><t:DayOrder>5</t:DayOrder><t:Month>3</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek></t:DaylightTime>
      </t:TimeZone>
      <m:MailboxDataArray>
        <t:MailboxData>
          <t:Email><t:Address>{email}</t:Address></t:Email>
          <t:AttendeeType>Required</t:AttendeeType>
        </t:MailboxData>
      </m:MailboxDataArray>
      <t:FreeBusyViewOptions>
        <t:TimeWindow>
          <t:StartTime>{start_date.strftime('%Y-%m-%dT%H:%M:%S')}</t:StartTime>
          <t:EndTime>{end_date.strftime('%Y-%m-%dT%H:%M:%S')}</t:EndTime>
        </t:TimeWindow>
        <t:MergedFreeBusyIntervalInMinutes>30</t:MergedFreeBusyIntervalInMinutes>
        <t:RequestedView>DetailedMerged</t:RequestedView>
      </t:FreeBusyViewOptions>
    </m:GetUserAvailabilityRequest>
  </soap:Body>
</soap:Envelope>'''
        
        auth = HttpNtlmAuth(f'{DOMAIN}\\{USERNAME}', PASSWORD)
        headers = {'Content-Type': 'text/xml; charset=utf-8'}
        
        response = requests.post(
            f'https://{SERVER}/EWS/Exchange.asmx',
            data=soap_request,
            headers=headers,
            auth=auth,
            verify=False
        )
        
        if response.status_code != 200:
            print(f"HTTP error: {response.status_code}")
            return
        
        ns = {
            'm': 'http://schemas.microsoft.com/exchange/services/2006/messages',
            't': 'http://schemas.microsoft.com/exchange/services/2006/types'
        }
        
        root = ET.fromstring(response.content)
        
        error = root.find('.//m:ResponseMessage[@ResponseClass="Error"]', ns)
        if error is not None:
            msg = error.find('m:MessageText', ns)
            print(f"Exchange error: {msg.text if msg is not None else 'Unknown error'}")
            return
        
        merged = root.find('.//t:MergedFreeBusy', ns)
        if merged is not None and merged.text:
            slots = merged.text
            print("Overview (30 min blocks, 08:00-18:00):")
            print(f"  Slots: {slots}")
            print("  Legend: 0=Free, 1=Tentative, 2=Busy, 3=Out of Office\n")
            
            # Calculate free periods
            free_periods = []
            current_free_start = None
            
            for i, slot in enumerate(slots):
                slot_time = start_date + timedelta(minutes=30*i)
                if slot == '0':  # Free
                    if current_free_start is None:
                        current_free_start = slot_time
                else:
                    if current_free_start is not None:
                        free_periods.append((current_free_start, slot_time))
                        current_free_start = None
            
            if current_free_start is not None:
                last_slot_end = start_date + timedelta(minutes=30*len(slots))
                free_periods.append((current_free_start, last_slot_end))
            
            if free_periods:
                print("Free times:")
                for fp_start, fp_end in free_periods:
                    print(f"  * {fp_start.strftime('%H:%M')}-{fp_end.strftime('%H:%M')}")
            else:
                print("No free time in this period")
                
    except Exception as e:
        print(f"Error: {e}")

def delete_meeting(date_str, subject_search=""):
    """Delete a calendar meeting by date and optional subject search."""
    from exchangelib import EWSDateTime, EWSTimeZone
    
    account = get_account()
    tz = EWSTimeZone(TIMEZONE)
    
    target_date = datetime.strptime(date_str, "%Y-%m-%d")
    start = EWSDateTime(target_date.year, target_date.month, target_date.day, 0, 0, 0, tzinfo=tz)
    end = EWSDateTime(target_date.year, target_date.month, target_date.day, 23, 59, 59, tzinfo=tz)
    
    items = list(account.calendar.view(start=start, end=end))
    
    if not items:
        print(f"No meetings found on {date_str}")
        return
    
    # Filter by subject if provided
    if subject_search:
        items = [item for item in items if subject_search.lower() in (item.subject or "").lower()]
    
    if not items:
        print(f"No meetings matching '{subject_search}' found on {date_str}")
        return
    
    if len(items) > 1:
        print(f"Found {len(items)} meetings on {date_str}:")
        for i, item in enumerate(items, 1):
            st = item.start.astimezone(tz).strftime('%H:%M')
            print(f"  {i}. {st} - {item.subject}")
        print("\nPlease specify subject to narrow down.")
        return
    
    item = items[0]
    st = item.start.astimezone(tz).strftime('%H:%M')
    subject = item.subject
    
    # Delete with cancellation notice to attendees
    item.delete(send_meeting_cancellations='SendToAllAndSaveCopy')
    
    print(f"Deleted: {subject}")
    print(f"  Date: {date_str} {st}")
    print("  Cancellation sent to attendees")


def _find_meeting(account, date_str, subject_search):
    """Find a meeting by date and subject. Returns (item, tz) or prints error."""
    from exchangelib import EWSDateTime, EWSTimeZone, Q
    
    tz = EWSTimeZone(TIMEZONE)
    target_date = datetime.strptime(date_str, "%Y-%m-%d")
    start = EWSDateTime(target_date.year, target_date.month, target_date.day, 0, 0, 0, tzinfo=tz)
    end = EWSDateTime(target_date.year, target_date.month, target_date.day, 23, 59, 59, tzinfo=tz)
    
    # Use filter (not view) to get editable items
    items = list(account.calendar.filter(
        Q(start__gte=start) & Q(start__lt=end) & Q(subject__icontains=subject_search)
    ))
    
    if not items:
        # Fallback: try view for recurring meetings, then get master item
        view_items = [item for item in account.calendar.view(start=start, end=end)
                      if subject_search.lower() in (item.subject or "").lower()]
        if view_items:
            # Get the actual item by ID
            from exchangelib import CalendarItem
            item = view_items[0]
            try:
                items = list(account.calendar.filter(subject__icontains=subject_search).order_by('-start')[:5])
                items = [i for i in items if subject_search.lower() in (i.subject or "").lower()]
            except Exception:
                pass
        
        if not items:
            print(f"No editable meetings matching '{subject_search}' found on {date_str}")
            return None, tz
    
    if len(items) > 1:
        print(f"Found {len(items)} matching meetings:")
        for i, item in enumerate(items, 1):
            st = item.start.strftime('%d.%m %H:%M') if hasattr(item.start, 'strftime') else str(item.start)
            print(f"  {i}. {st} - {item.subject}")
        print("Please narrow down the subject search.")
        return None, tz
    
    return items[0], tz


def _update_attendees_soap(item_id, changekey, all_attendees, mode='add'):
    """Update meeting attendees via raw SOAP (exchangelib doesn't support this)."""
    from xml.etree import ElementTree as ET
    import requests
    from requests_ntlm import HttpNtlmAuth
    
    attendees_xml = ""
    for email in all_attendees:
        attendees_xml += f"""<t:Attendee>
            <t:Mailbox><t:EmailAddress>{email}</t:EmailAddress></t:Mailbox>
          </t:Attendee>
"""
    
    soap = f'''<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013"/>
  </soap:Header>
  <soap:Body>
    <m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AutoResolve"
                  SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="{item_id}" ChangeKey="{changekey}"/>
          <t:Updates>
            <t:SetItemField>
              <t:FieldURI FieldUri="calendar:RequiredAttendees"/>
              <t:CalendarItem>
                <t:RequiredAttendees>
                  {attendees_xml}
                </t:RequiredAttendees>
              </t:CalendarItem>
            </t:SetItemField>
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>
  </soap:Body>
</soap:Envelope>'''
    
    auth = HttpNtlmAuth(f'{DOMAIN}\\{USERNAME}', PASSWORD)
    headers = {'Content-Type': 'text/xml; charset=utf-8'}
    
    response = requests.post(
        f'https://{SERVER}/EWS/Exchange.asmx',
        data=soap,
        headers=headers,
        auth=auth,
        verify=False
    )
    
    if response.status_code != 200:
        print(f"HTTP error: {response.status_code}")
        return False
    
    ns = {
        'm': 'http://schemas.microsoft.com/exchange/services/2006/messages',
        't': 'http://schemas.microsoft.com/exchange/services/2006/types'
    }
    root = ET.fromstring(response.content)
    
    resp_class = root.find('.//m:UpdateItemResponseMessage', ns)
    if resp_class is not None:
        rc = resp_class.get('ResponseClass')
        if rc == 'Success':
            return True
        msg = root.find('.//m:MessageText', ns)
        print(f"Exchange error: {msg.text if msg is not None else rc}")
        return False
    
    print(f"Unexpected response")
    return False


def add_attendee(date_str, subject_search, attendees_str):
    """Add attendees to an existing calendar meeting."""
    account = get_account()
    item, tz = _find_meeting(account, date_str, subject_search)
    if item is None:
        return
    
    new_emails = [e.strip().lower() for e in attendees_str.split(',')]
    
    existing = list(item.required_attendees or [])
    existing_emails = {(a.mailbox.email_address or '').lower() for a in existing}
    
    added = []
    all_emails = [a.mailbox.email_address for a in existing]
    for email in new_emails:
        if email not in existing_emails:
            all_emails.append(email)
            added.append(email)
    
    if not added:
        print("All specified attendees are already in the meeting.")
        return
    
    if _update_attendees_soap(item.id, item.changekey, all_emails):
        print(f"Updated: {item.subject}")
        print(f"  Added: {', '.join(added)}")
        print("  Updated invitations sent")
    else:
        print("Failed to update meeting.")


def remove_attendee(date_str, subject_search, attendees_str):
    """Remove attendees from an existing calendar meeting."""
    account = get_account()
    item, tz = _find_meeting(account, date_str, subject_search)
    if item is None:
        return
    
    remove_emails = {e.strip().lower() for e in attendees_str.split(',')}
    
    existing = list(item.required_attendees or [])
    new_list = [a for a in existing if (a.mailbox.email_address or '').lower() not in remove_emails]
    
    removed = len(existing) - len(new_list)
    if removed == 0:
        print("None of the specified attendees were found in the meeting.")
        return
    
    remaining_emails = [a.mailbox.email_address for a in new_list]
    
    if _update_attendees_soap(item.id, item.changekey, remaining_emails):
        print(f"Updated: {item.subject}")
        print(f"  Removed {removed} attendee(s)")
        print("  Updated invitations sent")
    else:
        print("Failed to update meeting.")


def create_meeting(subject, start_time_str, duration_min, attendees_str, body=""):
    """Create a calendar meeting and send invites."""
    from exchangelib import EWSDateTime, EWSTimeZone, CalendarItem, Attendee, Mailbox
    
    account = get_account()
    tz = EWSTimeZone(TIMEZONE)
    
    start_dt = datetime.strptime(start_time_str, "%Y-%m-%d %H:%M")
    end_dt = start_dt + timedelta(minutes=int(duration_min))
    
    start = EWSDateTime(start_dt.year, start_dt.month, start_dt.day, 
                        start_dt.hour, start_dt.minute, 0, tzinfo=tz)
    end = EWSDateTime(end_dt.year, end_dt.month, end_dt.day,
                      end_dt.hour, end_dt.minute, 0, tzinfo=tz)
    
    attendee_list = [email.strip() for email in attendees_str.split(',')]
    required_attendees = [Attendee(mailbox=Mailbox(email_address=email), response_type='Accept') 
                         for email in attendee_list]
    
    meeting = CalendarItem(
        account=account,
        folder=account.calendar,
        subject=subject,
        body=body,
        start=start,
        end=end,
        required_attendees=required_attendees
    )
    
    meeting.save(send_meeting_invitations='SendToAllAndSaveCopy')
    
    print(f"Meeting created: {subject}")
    print(f"  {start_dt.strftime('%d.%m.%Y %H:%M')} - {end_dt.strftime('%H:%M')}")
    print(f"  Attendees: {', '.join(attendee_list)}")
    print("  Invitations sent")

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    
    cmd = sys.argv[1].lower()
    
    if cmd == 'check':
        check_inbox()
    elif cmd == 'read':
        count = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        read_emails(count)
    elif cmd == 'send':
        if len(sys.argv) < 5:
            print("Usage: email_util.py send TO SUBJECT BODY")
            return
        send_email(sys.argv[2], sys.argv[3], ' '.join(sys.argv[4:]))
    elif cmd == 'search':
        if len(sys.argv) < 3:
            print("Usage: email_util.py search QUERY")
            return
        search_emails(' '.join(sys.argv[2:]))
    elif cmd in ['calendar', 'cal']:
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        show_calendar(days)
    elif cmd == 'pending':
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 30
        show_pending(days)
    elif cmd in ['freebusy', 'fb']:
        if len(sys.argv) < 3:
            print("Usage: email_util.py freebusy EMAIL [DAYS_OFFSET]")
            print("  DAYS_OFFSET: 0=today, 1=tomorrow (default), 2=day after, etc.")
            return
        email = sys.argv[2]
        days_offset = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        show_freebusy(email, days_offset)
    elif cmd == 'meeting':
        if len(sys.argv) < 6:
            print('Usage: email_util.py meeting SUBJECT "YYYY-MM-DD HH:MM" DURATION_MIN EMAIL1,EMAIL2 [BODY]')
            return
        subject = sys.argv[2]
        start_time = sys.argv[3]
        duration = sys.argv[4]
        attendees = sys.argv[5]
        body = ' '.join(sys.argv[6:]) if len(sys.argv) > 6 else ""
        create_meeting(subject, start_time, duration, attendees, body)
    elif cmd == 'add-attendee':
        if len(sys.argv) < 5:
            print('Usage: email_util.py add-attendee YYYY-MM-DD SUBJECT_SEARCH EMAIL1,EMAIL2')
            return
        add_attendee(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'remove-attendee':
        if len(sys.argv) < 5:
            print('Usage: email_util.py remove-attendee YYYY-MM-DD SUBJECT_SEARCH EMAIL1,EMAIL2')
            return
        remove_attendee(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd in ['delete', 'del']:
        if len(sys.argv) < 3:
            print('Usage: email_util.py delete YYYY-MM-DD [SUBJECT_SEARCH]')
            return
        date_str = sys.argv[2]
        subject_search = ' '.join(sys.argv[3:]) if len(sys.argv) > 3 else ""
        delete_meeting(date_str, subject_search)
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)

if __name__ == '__main__':
    main()
