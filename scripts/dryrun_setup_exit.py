import json, os, sys, datetime, time, urllib.request, collections
import pathlib
REPO=str(pathlib.Path(__file__).resolve().parents[1]); CACHE=os.environ.get("SETUP_EXIT_CACHE","/tmp/setup_exit_cache"); os.makedirs(CACHE,exist_ok=True)
TZ=datetime.timezone(datetime.timedelta(hours=8))
log=json.load(open(f"{REPO}/data/picks.json")); out=json.load(open(f"{REPO}/data/outcomes.json"))["records"]
idx={e["id"]:(b,e) for b in log["batches"] for e in b["entries"]}
trades=[]
for r in out:
    if r["horizon_h"]!=24: continue
    b,e=idx[r["pick_id"]]
    if e.get("type")!="buy": continue
    trades.append(dict(r=r,b=b,e=e))
trades.sort(key=lambda t:t["e"]["created_at"])
def klines(sym,t0,hours=24):
    fn=f"{CACHE}/{sym}_{int(t0.timestamp())}.json"
    if os.path.exists(fn): return json.load(open(fn))
    s=int(t0.timestamp()*1000); en=s+hours*3600_000
    for base in ("https://data-api.binance.vision","https://data-api.binance.vision","https://data-api.binance.vision"):
        time.sleep(1)
        try:
            d=json.load(urllib.request.urlopen(f"{base}/api/v3/klines?symbol={sym}&interval=5m&startTime={s}&endTime={en}&limit=1000",timeout=20))
            if isinstance(d,list):
                bars=[[int(k[0]),float(k[2]),float(k[3]),float(k[4]),int(k[6])] for k in d]
                json.dump(bars,open(fn,"w")); return bars
        except Exception as ex: print("err",sym,ex,file=sys.stderr)
    return None
missing=[]
for t in trades:
    e=t["e"]; t["t0"]=datetime.datetime.fromisoformat(e["created_at"])
    t["bars"]=klines(e["pair_address"].upper(),t["t0"]) if e["chain"]=="binance" else None
    if not t["bars"]: missing.append(e["id"])
    t["weak"]=(t["b"].get("regime") or {}).get("sizing")=="half"
    t["setup"]=e.get("angle") or "legacy(no angle)"

def sim(t,tp,sl,hold_h):
    """returns (ret, reason, exit_time) or None if no bars"""
    bars=t["bars"]; e=t["e"]
    if not bars: return None
    entry=float(e["entry_price_usd"]); sp=entry*(1-sl/100); tpp=entry*(1+tp/100)
    end_ms=int(t["t0"].timestamp()*1000)+hold_h*3600_000
    last=None
    for o,h,l,c,ct in bars:
        if o>=end_ms: break
        last=(c,ct)
        if l<=sp: return -sl,"stop",ct
        if h>=tpp: return tp,"tp",ct
    if hold_h==24 and t["r"].get("return_pct_eod") is not None:
        return t["r"]["return_pct_eod"],"time",end_ms  # sealed 1m due-close
    return round((last[0]/entry-1)*100,2),"time",end_ms

RULES={
 "S0 sealed (as booked)":None,
 "R1 +8/−5/24h (weak +5/−4) uniform":("cur",),
 "R2 +10/−4/12h (proposal)":(10,4,12),
 "R3 +10/−4/8h [in-sample]":(10,4,8),
 "R4 +6/−3/12h [in-sample]":(6,3,12),
 "R5 +10/−4/24h [in-sample]":(10,4,24),
 "R6 +8/−5/12h [in-sample]":(8,5,12),
}
FEE=0.2
def run(rule):
    res=[]
    for t in trades:
        if rule is None:
            r=t["r"]; ret=r["return_pct"]; why={"stop":"stop","take_profit":"tp"}.get(r["exit_reason"],"time")
            et=int(t["t0"].timestamp()*1000)+24*3600_000
        else:
            if rule==("cur",): tp,sl,hh=(5,4,24) if t["weak"] else (8,5,24)
            else: tp,sl,hh=rule
            x=sim(t,tp,sl,hh)
            if x is None:  # no Binance path (solana batch-001): keep sealed value
                r=t["r"]; ret=r["return_pct"]; why="nopath(sealed)"; et=int(t["t0"].timestamp()*1000)+24*3600_000
            else: ret,why,et=x
        res.append(dict(t=t,ret=ret,why=why,exit_ms=et))
    return res
def stats(rs):
    n=len(rs); 
    if not n: return dict(n=0)
    c=collections.Counter(x["why"] for x in rs)
    w=sum(1 for x in rs if x["ret"]>0); l=n-w
    ew=sum(x["ret"] for x in rs)/n
    return dict(n=n,tp=c["tp"],sl=c["stop"],time=c["time"],nopath=c["nopath(sealed)"],W=w,L=l,ew=round(ew,2),usd=round(sum(x["ret"] for x in rs),2),ew_fee=round(ew-FEE,2),usd_fee=round(sum(x["ret"] for x in rs)-FEE*n,2))
cut=datetime.datetime(2026,10,23,4,5,tzinfo=TZ)
def sizing(rs,base=100.0,frac=0.25):
    # gate: at entry, rolling 7d avg EW of trades already exited (exit<=entry, entry within prior 7d) >0 → full else frac
    full=quarter=0.0; nfull=0
    for x in rs:
        t0=x["t"]["t0"]; t0ms=int(t0.timestamp()*1000)
        prior=[y["ret"] for y in rs if y["exit_ms"]<=t0ms and y["t"]["t0"]>=t0-datetime.timedelta(days=7)]
        on = bool(prior) and sum(prior)/len(prior)>0
        stake=base if on else base*frac; nfull+=on
        full+=base*x["ret"]/100; quarter+=stake*(x["ret"]-0)/100
        x["stake"]=stake
    fees_full=base*FEE/100*len(rs); fees_q=sum(x["stake"]*FEE/100 for x in rs)
    return dict(full=round(full,2),full_fee=round(full-fees_full,2),q=round(quarter,2),q_fee=round(quarter-fees_q,2),n_full_size=nfull,n=len(rs),deployed_full=base*len(rs),deployed_q=sum(x["stake"] for x in rs))
R={}
for k,rule in RULES.items():
    rs=run(rule)
    R[k]=dict(all=stats(rs),bn=stats([x for x in rs if x["why"]!="nopath(sealed)"]),last7=stats([x for x in rs if x["t"]["t0"]>=cut]),
      setup={s:stats([x for x in rs if x["t"]["setup"]==s]) for s in sorted({x["t"]["setup"] for x in rs})},
      sizing=sizing(rs),
      rows=[(x["t"]["e"]["id"],x["t"]["setup"],x["ret"],x["why"]) for x in rs])
json.dump(dict(missing=missing,n=len(trades),R=R),open(os.environ.get("SETUP_EXIT_OUT","setup-exit-dryrun-20261030.json"),"w"),indent=1,ensure_ascii=False)
print("missing klines:",missing)
for k,v in R.items(): print(k,v["all"],"\n   bn47",v["bn"],"\n   last7",v["last7"],"\n   size",v["sizing"])
