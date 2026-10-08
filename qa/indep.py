import sys, json, hashlib, warnings, logging
logging.disable(logging.CRITICAL); warnings.filterwarnings('ignore')
import extract_msg
sha=lambda b: hashlib.sha256(b).hexdigest()
def model(msg):
    m={}
    m['class']=msg.classType if hasattr(msg,'classType') else None
    m['subject']=msg.subject
    m['sender']=msg.sender
    try: m['messageId']=msg.messageId
    except Exception: m['messageId']=None
    def rcpts(t):
        out=[]
        for r in msg.recipients:
            if r.type.name.lower()==t: out.append((r.name,r.email))
        return out
    try:
        m['to']=rcpts('to'); m['cc']=rcpts('cc')
    except Exception as e: m['to']=m['cc']=None; m['rcptErr']=str(e)[:80]
    try: m['date']=msg.date
    except Exception as e: m['date']=None
    try: m['body']=msg.body
    except Exception as e: m['body']=None
    if isinstance(m['body'],bytes): m['body']=m['body'].decode('utf8','replace')
    try: hb=msg.htmlBody
    except Exception: hb=None
    m['hasHtml']=bool(hb)
    try: m['hasRtf']=bool(msg.rtfBody)
    except Exception: m['hasRtf']=False
    atts=[]
    for a in msg.attachments:
        if not isinstance(a.data,(bytes,bytearray)) and a.data is not None:
            atts.append({'name':getattr(a,'name',None),'embedded':True,'sub':model(a.data)})
        else:
            d=a.data if isinstance(a.data,(bytes,bytearray)) else b''
            atts.append({'name':getattr(a,'longFilename',None) or getattr(a,'shortFilename',None) or getattr(a,'name',None),'sha':sha(d),'size':len(d)})
    m['atts']=atts
    return m
p=sys.argv[1]
try:
    msg=extract_msg.openMsg(p)
    out=model(msg); msg.close()
    out['date']=out['date'] if isinstance(out['date'],str) else (out['date'].isoformat() if out['date'] else None)
    def fix(o):
        if isinstance(o,dict): 
            if 'date' in o and not isinstance(o['date'],(str,type(None))): o['date']=str(o['date'])
            for a in o.get('atts',[]): 
                if a.get('sub'): fix(a['sub'])
    json.dump(out,open(sys.argv[2],'w'),default=str)
except Exception as e:
    json.dump({'fatal':repr(e)[:300]},open(sys.argv[2],'w'))
