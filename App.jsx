import { useState, useRef, useCallback, useEffect } from "react";

const MODEL = "claude-haiku-4-5-20251001";

async function callAI(system, messages, maxTokens = 250) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch('/api/claude', {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, messages, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status}`);
    const d = await res.json();
    return d.content?.[0]?.text || "";
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

const C = {
  ink:"#1A1108", gold:"#B8915A", bg:"#F9F5EF", paper:"#F3EDE3",
  rule:"rgba(26,17,8,.08)", dim:"rgba(26,17,8,.35)",
  soul:"#5A9A7A", notif:"#E8607A", err:"#B83232",
};
const serif = { fontFamily:"'Georgia',serif", fontStyle:"italic" };

const MATCH_CARDS = [
  { emoji:"🌙", name:"지현", att:"불안형", region:"서울", age:28, pct:68, fear:"버려지는 것", tags:["따뜻함","경청","감성"], score:91, tier:"운명의 단 하나", tc:"#C87050" },
  { emoji:"⚡", name:"도윤", att:"안정형", region:"부산", age:31, pct:82, fear:"정체되는 것", tags:["신뢰","솔직함"], score:78, tier:"영혼의 단짝", tc:"#9A7AC4" },
  { emoji:"✨", name:"수아", att:"안정형", region:"제주", age:26, pct:79, fear:"상처 주는 것", tags:["공감","따뜻함"], score:74, tier:"완벽한 궁합", tc:"#B8915A" },
];

const OB = [
  { emoji:"✨", title:"소울메이트를\n찾는 새로운 방법", desc:"외모 말고 진짜 나를 알아주는 사람.\nAI가 먼저 만나보고 연결해드려요." },
  { emoji:"💬", title:"소울이 이런 걸\n물어봐요", qs:["가까워질수록 오히려 불안해진 적 있어요?","상처받기 전에 먼저 거리를 두는 편이에요?","누군가 내 곁을 떠날까봐 무서웠던 적 있나요?"] },
  { emoji:"🤝", title:"AI 분신이\n먼저 만나봐요", desc:"내 페르소나와 상대 페르소나가\n실제로 대화하고 케미를 측정해요." },
  { emoji:"💌", title:"보고 결정하면\n돼요", desc:"궁합 점수, 100년 이야기,\n두 사람의 대화 하이라이트까지." },
];

// 소울 로컬 응답 — API 실패시 맥락 기반 즉시 반환 (반복 방지 포함)
const LOCAL_SOUL_POOL = {
  "사업매출돈": ["그게 계속되면 진짜 지치죠. 요즘 어떻게 버티고 있어요?","매출 걱정이 크겠다. 언제부터 그랬어요?","일이 잘 안 될 때 어떻게 버텨요?"],
  "잠수면": ["밤에 어떤 생각이 제일 많이 들어요?","잠 못 자는 게 얼마나 됐어요?","밤이 제일 힘들어요?"],
  "무서두렵": ["그 두려움, 언제부터 있었어요?","어떤 상황에서 제일 무서워요?","그게 어떨 때 제일 커요?"],
  "버려떠날": ["결국 제일 무서운 게 혼자 남는 것 같아요, 맞아요?","그 사람이 떠날까봐 항상 긴장하는 것 같아요.","그 두려움, 얼마나 됐어요?"],
  "불안긴장": ["그 불안, 어디서 오는 것 같아요?","불안할 때 어떻게 하는 편이에요?","그 불안이 언제부터 있었어요?"],
  "혼자외로": ["혼자일 때 어떤 생각이 제일 많이 들어요?","혼자 있는 게 편해요, 외로워요?","그 거리감, 언제부터 생겼어요?"],
  "힘들지쳐": ["뭐가 제일 힘든 것 같아요?","요즘 어떻게 버티고 있어요?","혼자 다 짊어지고 있는 것 같아요?"],
  "그냥모르겠없어": ["그냥인데 뭔가 있는 것 같기도 해요?","요즘 뭐가 제일 신경 쓰여요?","말하기 애매한 느낌이에요?"],
  "좋았행복즐거": ["오 좋았겠다. 그 순간 더 얘기해줄래요?","요즘도 그런 순간이 있어요?","그때 어떤 기분이었어요?"],
  "보통그래": ["보통인 날, 어떤 게 제일 힘들어요?","그냥 지나가는 날도 있죠. 요즘 어때요?","보통이라는 게 어떤 느낌이에요?"],
  "연애좋아": ["그 사람이랑 있을 때 어떤 느낌이에요?","그 사람 어떤 사람이에요?","그때 어떤 기분이었어요?"],
  "default": ["그때 어떤 기분이었어요?","맞아요, 그 느낌 알 것 같아요.","더 얘기해줄래요?","그거 진짜 힘드셨겠다.","언제부터 그랬어요?","그 얘기 더 들려줄래요?","그게 지금도 계속돼요?","그게 어떤 느낌이에요?"],
};

function getLocalSoulResp(msg, turn, used, att) {
  const m = msg || "";
  const u = used || [];
  // 키워드 매칭
  const keyMap = [
    ["사업매출돈", ["사업","매출","돈","수익","장사"]],
    ["잠수면", ["잠","못 자","수면","새벽","밤"]],
    ["무서두렵", ["무서","두렵","겁","공포"]],
    ["버려떠날", ["버려","떠날","이별","혼자남"]],
    ["불안긴장", ["불안","긴장","초조","걱정"]],
    ["혼자외로", ["혼자","외로","고독","쓸쓸"]],
    ["힘들지쳐", ["힘들","지쳐","힘겨","버거"]],
    ["그냥모르겠없어", ["그냥","모르겠","없어","없닥","딱히","별로"]],
    ["좋았행복즐거", ["좋았","행복","즐거","기뻐","설레"]],
    ["보통그래", ["보통","그래","그렇","그냥그래"]],
    ["연애좋아", ["연애","좋아","사귀","헤어"]],
  ];
  let poolKey = "default";
  for (const [key, words] of keyMap) {
    if (words.some(w => m.includes(w))) { poolKey = key; break; }
  }
  // att별 분기 — secure에게 anxious 프레임 금지
  let finalKey = poolKey;
  if (poolKey === "버려떠날") {
    finalKey = (att === "anxious") ? "버려떠날_anxious" : "버려떠날_other";
  }
  const pool = LOCAL_SOUL_POOL[finalKey] || LOCAL_SOUL_POOL[poolKey] || LOCAL_SOUL_POOL["default"];
  // 미사용 응답 우선
  const unused = pool.filter(r => !u.includes(r));
  if (unused.length > 0) return unused[turn % unused.length];
  // 전부 사용됐으면 default pool에서
  const defUnused = LOCAL_SOUL_POOL["default"].filter(r => !u.includes(r));
  return defUnused.length > 0 ? defUnused[0] : "그렇군요.";
}

function getContextChips(msg) {
  const m = msg || "";
  if (m.includes("사업") || m.includes("매출") || m.includes("일")) return ["요즘 얼마나 힘들어요?", "언제부터 그랬어요?"];
  if (m.includes("잠") || m.includes("수면") || m.includes("못 자")) return ["얼마나 됐어요?", "밤에 무슨 생각이 제일 많이 들어요?"];
  if (m.includes("친구") || m.includes("만났")) return ["그 친구 얘기 더 해줄래요", "만나고 나서 기분이 어때요?"];
  if (m.includes("무서") || m.includes("두렵")) return ["언제부터 그랬어요?", "어떤 상황에서 제일 그래요?"];
  if (m.includes("불안") || m.includes("긴장") || m.includes("초조")) return ["그 불안 언제 오는 것 같아요?", "어떻게 하는 편이에요?"];
  if (m.includes("혼자") || m.includes("거리")) return ["혼자 있을 때 어떤 생각 해요?", "그 감정 더 말해줄래요"];
  if (m.includes("힘들") || m.includes("지쳐") || m.includes("버거")) return ["뭐가 제일 힘든 것 같아요?", "요즘 어떻게 버티고 있어요?"];
  if (m.includes("그냥") || m.includes("모르겠") || m.includes("없어")) return ["그냥인 게 어떤 느낌이에요?", "요즘 뭐가 제일 신경 쓰여요?"];
  if (m.includes("좋았") || m.includes("행복") || m.includes("즐거")) return ["그 순간 더 얘기해줄래요", "요즘도 그런 적 있어요?"];
  if (m.includes("보통") || m.includes("그래") || m.includes("그렇")) return ["보통인 게 요즘 어때요?", "뭔가 있는데 말하기 애매한 느낌?"];
  if (m.includes("연애") || m.includes("좋아") || m.includes("헤어")) return ["그 사람 어떤 사람이에요?", "그때 어떤 기분이었어요?"];
  return ["더 얘기해줄래요", "그때 어떤 기분이었어요?"];
}

function soulSys(nick, pct, turn, att) {
  const stage = turn < 3 ? "초반" : turn < 6 ? "중반" : "후반";
  const a = att || "unknown";
  const guides = {
    anxious:  { 초반:"편안하게 받아주기.", 중반:"두려움 탐색: '그게 어떨 때 제일 무서워요?'", 후반:"'결국 제일 무서운 게 ~인 것 같아요, 맞아요?' 직접 확인." },
    avoidant: { 초반:"거리 존중. 감정 압박 금지.", 중반:"'혼자 있는 게 편한 편이에요?' 패턴 탐색.", 후반:"'반대로 어떨 때 제일 나다운 것 같아요?' 확인." },
    secure:   { 초반:"솔직하게 받아주기.", 중반:"'관계에서 제일 중요한 게 뭐예요?' 가치관 탐색.", 후반:"'어떨 때 제일 성장하는 느낌 들어요?' 확인." },
    unknown:  { 초반:"편안하게 받아주기. 판단 없이.", 중반:"패턴 슬쩍 짚기. 두려움 탐색.", 후반:"'결국 제일 무서운 게 ~인 것 같아요, 맞아요?' 확인." },
  };
  const g = (guides[a] || guides.unknown)[stage];
  const warn = a === "secure" ? " ⚠️secure-불안프레임금지." : a === "avoidant" ? " ⚠️avoidant-압박금지." : "";
  return `소울(${nick}의 AI파트너). ${stage}. 성향:${a}. ${g}${warn}
규칙:친구처럼.1~2문장.질문1개.직접반응.반복금지.상담사말투금지.자연스러운한국어.`;
}

function Bubble({ role, text, name, emoji }) {
  const isUser = role === "user";
  return (
    <div style={{ display:"flex", justifyContent:isUser?"flex-end":"flex-start", marginBottom:12, animation:"up .3s ease" }}>
      {!isUser && (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:3 }}>
            <div style={{ width:16, height:16, borderRadius:"50%", background:"rgba(90,154,122,.2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:9 }}>{emoji || "🌿"}</div>
            <p style={{ fontSize:10, color:C.dim }}>{name || "소울"} · AI</p>
          </div>
          <div style={{ background:C.paper, border:`1px solid ${C.rule}`, padding:"10px 13px", fontSize:13, lineHeight:1.75, maxWidth:"82%" }}>{text}</div>
        </div>
      )}
      {isUser && <div style={{ background:C.ink, color:C.bg, padding:"10px 13px", fontSize:13, lineHeight:1.75, maxWidth:"82%" }}>{text}</div>}
    </div>
  );
}

function Typing({ name, emoji }) {
  return (
    <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:12 }}>
      <div>
        <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:3 }}>
          <div style={{ width:16, height:16, borderRadius:"50%", background:"rgba(90,154,122,.2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:9 }}>{emoji || "🌿"}</div>
          <p style={{ fontSize:10, color:C.dim }}>{name || "소울"} · AI</p>
        </div>
        <div style={{ display:"flex", gap:4, padding:"10px 13px", background:C.paper, border:`1px solid ${C.rule}` }}>
          {[0,150,300].map(d => <div key={d} style={{ width:6, height:6, borderRadius:"50%", background:C.dim, animation:`dot .8s ${d}ms ease-in-out infinite` }} />)}
        </div>
      </div>
    </div>
  );
}

function BNav({ tab, onSwitch, notif, pct, onLocked }) {
  const items = [
    { id:"soul",   label:"소울",  locked:false, svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" strokeDasharray="2 2"/><circle cx="12" cy="12" r="11" strokeDasharray="3 3" opacity=".4"/></svg> },
    { id:"match",  label:"매칭",  locked:pct<30, svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21C12 21 3 14.5 3 8.5C3 5.42 5.42 3 8.5 3C10.24 3 11.91 3.81 13 5.08C14.09 3.81 15.76 3 17.5 3C20.58 3 23 5.42 23 8.5C23 11.58 20.58 14 17.5 14H14L12 21Z"/></svg> },
    { id:"result", label:"결과",  locked:false, svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg> },
    { id:"chat",   label:"채팅",  locked:false, svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 15C21 15.53 20.79 16.04 20.41 16.41C20.04 16.79 19.53 17 19 17H7L3 21V5C3 4.47 3.21 3.96 3.59 3.59C3.96 3.21 4.47 3 5 3H19C19.53 3 20.04 3.21 20.41 3.59C20.79 3.96 21 4.47 21 5V15Z"/></svg> },
    { id:"me",     label:"나",    locked:false, svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="8" r="4"/><path d="M4 20C4 16.134 7.582 13 12 13C16.418 13 20 16.134 20 20H4Z"/></svg> },
  ];
  return (
    <div style={{ borderTop:`1px solid ${C.rule}`, background:"rgba(249,245,239,.97)", display:"flex", flexShrink:0 }}>
      {items.map(item => (
        <button key={item.id}
          onClick={() => { if (item.locked) { onLocked && onLocked("소울과 30% 이상 대화하면 열려요 🌿"); return; } onSwitch(item.id); }}
          style={{ flex:1, padding:"9px 0 7px", background:"none", border:"none", display:"flex", flexDirection:"column", alignItems:"center", gap:3, cursor:"pointer" }}>
          <span style={{ opacity:item.locked ? 0.2 : tab===item.id ? 1 : 0.3, transition:"opacity .2s", position:"relative", display:"flex" }}>
            {item.svg}
            {item.id==="result" && notif>0 && <span style={{ position:"absolute", top:-3, right:-4, width:7, height:7, borderRadius:"50%", background:C.notif }} />}
          </span>
          <span style={{ fontSize:8, letterSpacing:".1em", textTransform:"uppercase", color:tab===item.id?C.ink:C.dim, fontWeight:tab===item.id?500:300 }}>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState("join");
  const [tab, setTab] = useState("soul");
  const [nick, setNick] = useState("");
  const [nickErr, setNickErr] = useState("");
  const [obStep, setObStep] = useState(0);
  const [obSel, setObSel] = useState({});
  const [pct, setPct] = useState(0);
  const [turnCount, setTurnCount] = useState(0);
  const [soulMsgs, setSoulMsgs] = useState([]);
  const [soulInput, setSoulInput] = useState("");
  const [soulBusy, setSoulBusy] = useState(false);
  const [chips, setChips] = useState([]);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [sheetCard, setSheetCard] = useState(null);
  const [sheetTab, setSheetTab] = useState("overview");
  const [toast, setToast] = useState("");
  const [notif, setNotif] = useState(1);
  const [vec, setVec] = useState({});

  const soulHist = useRef([]);
  const chatHist = useRef([]);
  const soulRef = useRef(null);
  const chatRef = useRef(null);
  const toastTimer = useRef(null);
  const theme = useRef(["요즘 어떤 감정이 제일 컸어요?", "최근에 누군가한테 고마웠던 적 있어요?", "혼자 있을 때 어떤 생각이 많이 들어요?"][Math.floor(Math.random() * 3)]);

  useEffect(() => { if (soulRef.current) soulRef.current.scrollTop = soulRef.current.scrollHeight; }, [soulMsgs, soulBusy]);
  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [chatMsgs, chatBusy]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2500);
  }, []);

  const getMode = (p) => p < 20 ? "처음 만남" : p < 40 ? "연결되는 중" : p < 60 ? "심화 중" : p < 80 ? "자기 발견" : "페르소나 완성";

  const detectAtt = useCallback((msgs) => {
    const t = msgs.join(" ");
    const a = ["불안","무서","버려","확인","연락","걱정","긴장","자책","두렵"].filter(w => t.includes(w)).length;
    const av = ["혼자","부담","의존","어색","별로","알아서","거리","독립"].filter(w => t.includes(w)).length;
    const s = ["솔직","직접","대화","성장","이해","명확","같이","편해"].filter(w => t.includes(w)).length;
    if (a >= 2 && a > av && a > s) return "anxious";
    if (av >= 2 && av > a && av > s) return "avoidant";
    if (s >= 2 && s > a && s > av) return "secure";
    return "unknown";
  }, []);

  const doJoin = useCallback(() => {
    const n = nick.trim();
    if (!n) { setNickErr("닉네임을 입력해주세요"); return; }
    if (n.length < 2) { setNickErr("2자 이상 입력해주세요"); return; }
    setNickErr(""); setScreen("onboard"); setObStep(0);
  }, [nick]);

  const startSoul = useCallback(async () => {
    setScreen("main"); setTab("soul"); setSoulBusy(true);
    let g = `안녕하세요, ${nick}! 저는 소울이에요. 요즘 어떤 감정이 제일 컸어요?`;
    try {
      const p1 = callAI(soulSys(nick, 0, 0, "unknown"), [{ role:"user", content:`${nick}와 첫 소울 대화. 테마: "${theme.current}" — 자연스럽게 인사하며 시작. 1~2문장.` }], 150);
      const t1 = new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000));
      g = await Promise.race([p1, t1]);
    } catch {}
    setSoulMsgs([{ role:"soul", text:g }]);
    soulHist.current = [{ role:"assistant", content:g }];
    setChips(["오늘 어떤 하루였어요?", "요즘 어때요?"]);
    setSoulBusy(false);
  }, [nick]);

  const sendSoul = useCallback(async () => {
    const text = soulInput.trim();
    if (!text || soulBusy) return;
    setSoulInput("");
    setSoulMsgs(p => [...p, { role:"user", text }]);
    soulHist.current.push({ role:"user", content:text });
    const nt = turnCount + 1; setTurnCount(nt);
    const np = Math.min(100, pct + Math.floor(Math.random() * 5) + 4); setPct(np);
    setChips([]); setSoulBusy(true);
    const uAll = soulHist.current.filter(m => m.role === "user").map(m => m.content);
    const att = uAll.length >= 2 ? detectAtt(uAll) : "unknown";
    // Promise.race — 8초 안에 API 응답 없으면 로컬
    const usedResps = soulHist.current.filter(m=>m.role==="assistant").map(m=>m.content);
    let resp;
    try {
      const apiP = callAI(soulSys(nick, np, nt, att), soulHist.current.slice(-20), 120);
      const toP = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000));
      resp = await Promise.race([apiP, toP]);
    } catch {
      resp = getLocalSoulResp(text, nt, usedResps);
    }
    // 질문 2개 이상이면 첫 번째만
    const qParts = resp.match(/[^.!?？。]*[?？]/g);
    if (qParts && qParts.length > 1) resp = qParts[0].trim();
    // 80자 초과 시 자르기
    if (resp.length > 80) resp = resp.slice(0, 80).replace(/[,，]?$/, '') + '.';

    setSoulMsgs(p => [...p, { role:"soul", text:resp }]);
    soulHist.current.push({ role:"assistant", content:resp });
    if (nt === 5) setTimeout(() => setSoulMsgs(p => [...p, { role:"note", text:`페르소나 발견 ✦ 소울이 ${nick}을 조금 알게 됐어요` }]), 400);
    setChips(getContextChips(text));
    // vec 로컬 분석
    if (nt % 5 === 0) {
      const joined = uAll.join(" ");
      const a = ["불안","무서","버려","확인","걱정","긴장","자책","두렵"].filter(w=>joined.includes(w)).length;
      const av = ["혼자","부담","의존","어색","거리","독립","싫어"].filter(w=>joined.includes(w)).length;
      const s = ["솔직","직접","대화","성장","이해","명확","같이"].filter(w=>joined.includes(w)).length;
      const attachment = a>=2&&a>av&&a>s?"anxious":av>=2&&av>a&&av>s?"avoidant":"secure";
      const core_emotion = attachment==="anxious"?"불안":attachment==="avoidant"?"고독":"신뢰";
      const fearWords=[["버려","버려지는 것"],["무시","무시당하는 것"],["약해","약해 보이는 것"],["통제","통제를 잃는 것"],["상처","상처 주는 것"],["정체","정체되는 것"]];
      const fear = fearWords.find(([w])=>joined.includes(w))?.[1]||"알 수 없음";
      const shine = attachment==="anxious"?"이해받을 때":attachment==="avoidant"?"혼자 집중할 때":"함께 성장할 때";
      setVec({core_emotion,attachment,fear,shine,confidence:70});
    }
    setSoulBusy(false);
  }, [soulInput, soulBusy, nick, pct, turnCount, detectAtt]);

  const sendChat = useCallback(async (text) => {
    const msg = text || chatInput.trim();
    if (!msg || chatBusy) return;
    setChatInput("");
    setChatMsgs(p => [...p, { role:"user", text:msg }]);
    chatHist.current.push({ role:"user", content:msg });
    setChatBusy(true);
    // 지현 로컬 응답 풀
    const JIHYUN_LOCAL = [
      "그렇군요.", "아, 그렇구나.", "그게 어떤 느낌이에요?",
      "저도 그런 적 있어요.", "음... 그거 쉽지 않았겠다.",
      "그 얘기 더 해줄래요?", "버려진다는 느낌, 저도 알 것 같아요.",
      "솔직하게 말해줘서 좋아요.", "그때 많이 힘들었겠다.",
    ];
    const usedChat = chatHist.current.filter(m=>m.role==="assistant").map(m=>m.content);
    let chatResp;
    try {
      const cp = callAI(`당신은 지현 — 30세 여성. 불안형 애착. 버려지는 것을 두려워함. 짧고 자연스럽게. 1~2문장. 한국어 구어체.`, chatHist.current.slice(-10), 150);
      const ct = new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000));
      chatResp = await Promise.race([cp, ct]);
    } catch {
      const unused = JIHYUN_LOCAL.filter(r => !usedChat.includes(r));
      chatResp = unused.length > 0 ? unused[0] : "그렇군요.";
    }
    setChatMsgs(p => [...p, { role:"ai", text:chatResp }]);
    chatHist.current.push({ role:"assistant", content:chatResp });
    setChatBusy(false);
  }, [chatInput, chatBusy]);

  const openSheet = (card) => { setSheetCard(card); setSheetTab("overview"); setShowSheet(true); };
  const acceptMatch = () => {
    setShowSheet(false);
    setChatMsgs([{ role:"system", text:"💌 페르소나끼리 먼저 만났어요\n\"버려지는 게 무섭다고 했잖아요, 나도요\"\n\n이제 직접 대화를 시작해봐요 ✦" }]);
    chatHist.current = []; setTab("chat"); showToast("채팅방이 열렸어요! ✦"); setNotif(0);
  };

  return (
    <div style={{ fontFamily:"'DM Sans',-apple-system,sans-serif", fontWeight:300, color:C.ink, height:"100vh", background:"#C4BAB0", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400;1,600&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
        input,button{font-family:inherit} input:focus{outline:none}
        body{padding-bottom:env(safe-area-inset-bottom)}
        @keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes dot{0%,100%{transform:scaleY(1);opacity:.3}50%{transform:scaleY(1.8);opacity:1}}
        @keyframes wave{0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(1.6);opacity:.08}}
        @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
        ::-webkit-scrollbar{display:none}
      `}</style>

      <div style={{ width:375, height:"min(812px,100vh)", background:C.bg, borderRadius:44, overflow:"hidden", border:"9px solid #111", boxShadow:"0 32px 64px rgba(0,0,0,.35)", display:"flex", flexDirection:"column", position:"relative" }}>

        {/* 가입 */}
        {screen === "join" && (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"0 28px" }}>
            <div style={{ width:"100%", maxWidth:320, animation:"up .5s ease" }}>
              <div style={{ position:"relative", width:68, height:68, margin:"0 auto 24px" }}>
                {[0,.4,.8].map((d,i) => <div key={i} style={{ position:"absolute", inset:i*8, borderRadius:"50%", background:C.gold, opacity:[.07,.13,.2][i], animation:`wave 2.6s ${d}s ease-in-out infinite` }} />)}
                <div style={{ position:"absolute", inset:22, borderRadius:"50%", background:C.gold, display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:"#fff" }} />
                </div>
              </div>
              <p style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", fontStyle:"italic", fontWeight:300, fontSize:48, textAlign:"center", marginBottom:6, letterSpacing:"0.08em", color:C.ink, lineHeight:1 }}>Soulscope</p>
              <p style={{ fontSize:12, color:C.dim, textAlign:"center", lineHeight:1.9, marginBottom:6 }}>AI가 먼저 만나보고<br/>소울메이트를 연결해드려요</p>
              <div style={{ display:"flex", justifyContent:"center", gap:16, marginBottom:24 }}>
                {[["💬","소울 대화"],["🤖","AI 매칭"],["💌","실제 연결"]].map(([ic,lb]) => (
                  <div key={lb} style={{ textAlign:"center" }}>
                    <div style={{ fontSize:17, marginBottom:3 }}>{ic}</div>
                    <p style={{ fontSize:9, color:C.dim }}>{lb}</p>
                  </div>
                ))}
              </div>
              {/* 카카오 버튼 */}
              <button onClick={() => {
                const url = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/authorize?provider=kakao&redirect_to=${encodeURIComponent(window.location.origin)}&scopes=profile_nickname`;
                window.location.href = url;
              }}
                style={{ width:"100%", padding:15, background:"#FEE500", color:"#191919", border:"none", fontSize:15, fontWeight:700, cursor:"pointer", marginBottom:8, display:"flex", alignItems:"center", justifyContent:"center", gap:9 }}>
                <span style={{ fontSize:18 }}>💬</span>카카오로 시작하기
              </button>
              <div style={{ display:"flex", alignItems:"center", gap:12, margin:"14px 0" }}>
                <div style={{ flex:1, height:1, background:C.rule }} />
                <span style={{ fontSize:10, color:C.dim }}>닉네임으로 시작</span>
                <div style={{ flex:1, height:1, background:C.rule }} />
              </div>
              <p style={{ fontSize:10, color:C.dim, letterSpacing:".12em", textTransform:"uppercase", marginBottom:7 }}>닉네임</p>
              <input value={nick} onChange={e => setNick(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) doJoin(); }}
                placeholder="나를 부를 이름" autoFocus
                style={{ width:"100%", border:`1px solid ${nickErr ? C.err : C.rule}`, background:C.bg, padding:"12px 14px", fontSize:14, color:C.ink, marginBottom:6, display:"block" }} />
              {nickErr && <p style={{ fontSize:11, color:C.err, marginBottom:8 }}>{nickErr}</p>}
              <button onClick={doJoin}
                style={{ width:"100%", padding:13, background:C.ink, color:C.bg, border:"none", fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer", fontWeight:500, marginBottom:14 }}>
                소울 시작하기 →
              </button>
              <p style={{ fontSize:10, color:C.dim, textAlign:"center", lineHeight:1.6 }}>🔒 실제 Claude AI와 대화해요</p>
            </div>
          </div>
        )}

        {/* 온보딩 */}
        {screen === "onboard" && (
          <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
            <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"0 32px", textAlign:"center" }}>
              <div key={obStep} style={{ animation:"up .35s ease", width:"100%", maxWidth:320 }}>
                <div style={{ fontSize:52, marginBottom:18, animation:"float 4s ease-in-out infinite" }}>{OB[obStep].emoji}</div>
                <h2 style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontWeight:300, fontSize:28, lineHeight:1.3, marginBottom:12, whiteSpace:"pre-line" }}>{OB[obStep].title}</h2>
                {OB[obStep].qs ? (
                  <div style={{ textAlign:"left" }}>
                    {OB[obStep].qs.map((q, i) => (
                      <div key={i} onClick={() => setObSel(prev => ({ ...prev, [`${obStep}-${i}`]:true }))}
                        style={{ padding:"11px 13px", marginBottom:7, background:obSel[`${obStep}-${i}`] ? C.ink : C.paper, color:obSel[`${obStep}-${i}`] ? C.bg : C.ink, border:`1px solid ${C.rule}`, fontSize:12, lineHeight:1.65, cursor:"pointer", transition:"all .2s" }}>
                        {q}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize:13, color:C.dim, lineHeight:1.85, whiteSpace:"pre-line" }}>{OB[obStep].desc}</p>
                )}
              </div>
            </div>
            <div style={{ display:"flex", justifyContent:"center", gap:7, marginBottom:18 }}>
              {OB.map((_, i) => <div key={i} style={{ width:i===obStep?20:6, height:6, borderRadius:3, background:i===obStep?C.ink:C.rule, transition:"all .3s" }} />)}
            </div>
            <div style={{ padding:"0 24px 32px" }}>
              <button onClick={() => { if (obStep < OB.length - 1) setObStep(o => o + 1); else startSoul(); }}
                style={{ width:"100%", padding:13, background:C.ink, color:C.bg, border:"none", fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer", fontWeight:500 }}>
                {obStep === OB.length - 1 ? `${nick}, 소울 시작하기 →` : "다음 →"}
              </button>
              <button onClick={startSoul} style={{ display:"block", margin:"12px auto 0", fontSize:11, color:C.dim, background:"none", border:"none", cursor:"pointer" }}>건너뛰기</button>
            </div>
          </div>
        )}

        {/* 메인 */}
        {screen === "main" && (
          <>
            {/* 소울 탭 */}
            {tab === "soul" && (
              <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden" }}>
                <div style={{ height:50, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 18px", borderBottom:`1px solid ${C.rule}`, flexShrink:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <div style={{ width:7, height:7, borderRadius:"50%", background:C.soul }} />
                    <span style={{ fontSize:10, color:C.dim }}>소울 AI</span>
                  </div>
                  <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:19 }}>나의 소울</span>
                  <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:13, color:C.gold }}>{pct}%</span>
                </div>
                <div style={{ padding:"8px 18px", background:"rgba(90,154,122,.07)", borderBottom:`1px solid rgba(90,154,122,.18)`, flexShrink:0 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                    <span style={{ fontSize:10, color:C.soul, letterSpacing:".1em", textTransform:"uppercase" }}>{getMode(pct)}</span>
                    <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:12, color:C.soul }}>{pct}%</span>
                  </div>
                  <div style={{ height:2, background:C.rule }}>
                    <div style={{ height:"100%", width:`${pct}%`, background:C.soul, transition:"width .8s" }} />
                  </div>
                </div>
                <div style={{ padding:"7px 18px", background:"rgba(90,154,122,.04)", borderBottom:`1px solid rgba(90,154,122,.1)`, flexShrink:0 }}>
                  <span style={{ fontSize:10, color:C.dim, letterSpacing:".1em", textTransform:"uppercase", marginRight:7 }}>오늘</span>
                  <span style={{ fontSize:11, color:C.dim }}>{theme.current}</span>
                </div>
                <div ref={soulRef} style={{ flex:1, overflowY:"auto", padding:"16px 18px" }}>
                  {soulMsgs.map((m, i) => (
                    m.role === "note"
                      ? <div key={i} style={{ textAlign:"center", margin:"10px 0", animation:"up .3s ease" }}>
                          <p style={{ fontSize:11, color:C.soul, background:"rgba(90,154,122,.08)", display:"inline-block", padding:"5px 12px", border:`1px solid rgba(90,154,122,.22)` }}>{m.text}</p>
                        </div>
                      : <Bubble key={i} role={m.role === "soul" ? "ai" : "user"} text={m.text} />
                  ))}
                  {soulBusy && <Typing />}
                </div>
                <div style={{ padding:"7px 18px", borderTop:`1px solid ${C.rule}`, background:"rgba(249,245,239,.97)", flexShrink:0, display:"flex", gap:6, flexWrap:"wrap", minHeight:38, alignItems:"center" }}>
                  {soulBusy && chips.length === 0 && <span style={{ fontSize:10, color:C.dim }}>소울이 생각 중...</span>}
                  {chips.map((chip, i) => (
                    <span key={i} onClick={() => { setSoulInput(chip); setTimeout(sendSoul, 50); }}
                      style={{ fontSize:10, color:C.dim, border:`1px solid ${C.rule}`, padding:"3px 9px", cursor:"pointer" }}>
                      {chip}
                    </span>
                  ))}
                </div>
                <div style={{ padding:"10px 16px", borderTop:`1px solid ${C.rule}`, background:"rgba(249,245,239,.97)", display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
                  <input value={soulInput} onChange={e => setSoulInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !soulBusy && !e.nativeEvent.isComposing) sendSoul(); }}
                    placeholder={turnCount < 2 ? theme.current : "소울에게 말해봐요..."}
                    style={{ flex:1, border:`1px solid ${C.rule}`, background:C.bg, padding:"11px 13px", fontSize:13, color:C.ink }} />
                  <button onClick={() => { if (!soulBusy) sendSoul(); }} disabled={soulBusy}
                    style={{ background:soulBusy ? "rgba(26,17,8,.25)" : C.ink, color:C.bg, border:"none", padding:"11px 16px", fontSize:10, letterSpacing:".1em", textTransform:"uppercase", cursor:soulBusy ? "not-allowed" : "pointer", flexShrink:0 }}>
                    {soulBusy ? "..." : "전송"}
                  </button>
                </div>
                <BNav tab={tab} onSwitch={setTab} notif={notif} pct={pct} onLocked={showToast} />
              </div>
            )}

            {/* 매칭 탭 */}
            {tab === "match" && (
              <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden" }}>
                <div style={{ height:50, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 18px", borderBottom:`1px solid ${C.rule}`, flexShrink:0 }}>
                  <span style={{ fontSize:10, color:C.dim }}>오늘 3회 남음</span>
                  <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:19 }}>페르소나 매칭</span>
                  <span style={{ fontSize:13, color:C.dim, cursor:"pointer" }} onClick={() => showToast("새로고침 됐어요")}>↻</span>
                </div>
                <div style={{ flex:1, overflowY:"auto", padding:"16px 18px" }}>
                  <div style={{ background:C.ink, color:C.bg, padding:"14px 16px", marginBottom:16 }}>
                    <p style={{ fontSize:9, color:"rgba(249,245,239,.4)", letterSpacing:".12em", textTransform:"uppercase", marginBottom:9 }}>나의 AI 페르소나</p>
                    <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                      <div style={{ width:44, height:44, borderRadius:"50%", background:"rgba(90,154,122,.25)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>🌿</div>
                      <div style={{ flex:1 }}>
                        <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:20, marginBottom:2 }}>{nick}</p>
                        <p style={{ fontSize:11, color:"rgba(249,245,239,.5)" }}>{vec?.core_emotion || "분석 중"} · {vec?.attachment === "anxious" ? "불안형" : vec?.attachment === "avoidant" ? "회피형" : vec?.attachment === "secure" ? "안정형" : "?"}</p>
                        {vec?.fear && <p style={{ fontSize:10, color:"rgba(184,145,90,.7)", marginTop:2 }}>"{vec.fear}을 두려워해요"</p>}
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:22, color:C.gold }}>{pct}%</p>
                      </div>
                    </div>
                  </div>
                  {MATCH_CARDS.map((card, i) => (
                    <div key={i} style={{ background:C.paper, border:`1px solid ${C.rule}`, padding:14, marginBottom:10 }}>
                      <div style={{ display:"flex", gap:11, alignItems:"flex-start", marginBottom:10 }}>
                        <div style={{ width:44, height:44, borderRadius:"50%", background:"rgba(200,144,106,.18)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>{card.emoji}</div>
                        <div style={{ flex:1 }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:3 }}>
                            <span>
                              <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:19 }}>{card.name}</span>
                              <span style={{ fontSize:10, color:"#5A9A82", border:"1px solid rgba(90,154,130,.3)", padding:"1px 6px", marginLeft:6, verticalAlign:"middle" }}>AI</span>
                            </span>
                            <span style={{ fontSize:10, color:C.dim }}>{card.att}</span>
                          </div>
                          <div style={{ display:"flex", gap:5, marginBottom:4, flexWrap:"wrap" }}>
                            <span style={{ fontSize:10, color:C.dim, border:`1px solid ${C.rule}`, padding:"1px 5px" }}>{card.region}</span>
                            <span style={{ fontSize:10, color:C.dim, border:`1px solid ${C.rule}`, padding:"1px 5px" }}>{card.age}세</span>
                            <span style={{ fontSize:10, color:C.gold, border:"1px solid rgba(184,145,90,.4)", padding:"1px 5px" }}>페르소나 {card.pct}%</span>
                          </div>
                          <p style={{ fontSize:11, color:C.dim, fontStyle:"italic", marginBottom:5 }}>"{card.fear}을 두려워해요"</p>
                          <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                            {card.tags.map(t => <span key={t} style={{ fontSize:10, color:C.dim, border:`1px solid ${C.rule}`, padding:"2px 7px" }}>{t}</span>)}
                          </div>
                        </div>
                      </div>
                      <button onClick={() => openSheet(card)}
                        style={{ width:"100%", padding:10, background:C.ink, color:C.bg, border:"none", fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer", fontWeight:500 }}>
                        페르소나 대화 시작 ✦
                      </button>
                    </div>
                  ))}
                </div>
                <BNav tab={tab} onSwitch={setTab} notif={notif} pct={pct} onLocked={showToast} />
              </div>
            )}

            {/* 결과 탭 */}
            {tab === "result" && (
              <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden" }}>
                <div style={{ height:50, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 18px", borderBottom:`1px solid ${C.rule}`, flexShrink:0 }}>
                  <span />
                  <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:19 }}>매칭 결과</span>
                  {notif > 0 ? <span style={{ fontSize:10, color:C.notif }}>{notif}개 NEW</span> : <span />}
                </div>
                <div style={{ flex:1, overflowY:"auto", padding:"16px 18px" }}>
                  {MATCH_CARDS.slice(0, 1).map((card, i) => (
                    <div key={i} style={{ background:C.paper, border:`1px solid ${C.rule}`, padding:14, marginBottom:10, cursor:"pointer" }} onClick={() => openSheet(card)}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                          <div style={{ width:38, height:38, borderRadius:"50%", background:"rgba(200,144,106,.18)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>{card.emoji}</div>
                          <div>
                            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:3 }}>
                              <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18 }}>{card.name}</span>
                              {notif > 0 && <span style={{ fontSize:10, color:"#fff", background:C.notif, padding:"1px 6px" }}>NEW</span>}
                            </div>
                            <p style={{ fontSize:10, color:C.dim }}>자동 매칭 · 방금 전</p>
                          </div>
                        </div>
                        <div style={{ textAlign:"right" }}>
                          <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:30, color:card.tc }}>{card.score}</p>
                          <p style={{ fontSize:10, color:card.tc }}>{card.tier}</p>
                        </div>
                      </div>
                      <p style={{ fontSize:12, color:C.dim, marginBottom:10, fontStyle:"italic" }}>말없이 통하는 고요함</p>
                      <div style={{ padding:"8px 10px", background:"rgba(200,112,80,.06)", marginBottom:10, borderLeft:"2px solid rgba(200,112,80,.32)" }}>
                        <p style={{ fontSize:11, color:C.dim, lineHeight:1.7 }}>✦ 서로의 두려움을 건드리고도 자연스럽게 이어진 순간</p>
                      </div>
                      <div style={{ display:"flex", gap:8 }}>
                        <button onClick={e => { e.stopPropagation(); showToast("거절했어요"); }}
                          style={{ flex:1, padding:9, background:"transparent", color:C.dim, border:`1px solid ${C.rule}`, fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer" }}>거절</button>
                        <button onClick={e => { e.stopPropagation(); openSheet(card); }}
                          style={{ flex:1, padding:10, background:C.ink, color:C.bg, border:"none", fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer" }}>자세히 보기 ✦</button>
                      </div>
                    </div>
                  ))}
                  <div style={{ textAlign:"center", padding:"30px 0" }}>
                    <div style={{ fontSize:28, marginBottom:10, animation:"float 4s ease-in-out infinite" }}>✦</div>
                    <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:16, marginBottom:6 }}>소울이 더 찾고 있어요</p>
                    <p style={{ fontSize:11, color:C.dim }}>소울과 대화할수록 더 잘 맞는<br/>소울메이트가 연결돼요</p>
                  </div>
                </div>
                <BNav tab={tab} onSwitch={setTab} notif={notif} pct={pct} onLocked={showToast} />
              </div>
            )}

            {/* 채팅 탭 */}
            {tab === "chat" && (
              <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden" }}>
                <div style={{ height:50, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 18px", borderBottom:`1px solid ${C.rule}`, flexShrink:0 }}>
                  <span onClick={() => setTab("result")} style={{ fontSize:11, color:C.dim, cursor:"pointer" }}>← 목록</span>
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1 }}>
                    <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:17 }}>지현</span>
                    <span style={{ fontSize:9, color:C.soul }}>AI 페르소나</span>
                  </div>
                  <span style={{ fontSize:14, color:C.dim }}>⋯</span>
                </div>
                <div ref={chatRef} style={{ flex:1, overflowY:"auto", padding:"16px 18px" }}>
                  {chatMsgs.length === 0 && (
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", padding:"0 24px", textAlign:"center" }}>
                      <div style={{ fontSize:32, marginBottom:14 }}>💌</div>
                      <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:18, marginBottom:8 }}>아직 연결된 사람이 없어요</p>
                      <p style={{ fontSize:12, color:C.dim, lineHeight:1.8, marginBottom:18 }}>결과 탭에서 매칭된 사람을<br/>수락하면 대화가 시작돼요</p>
                      <button onClick={() => setTab("result")}
                        style={{ padding:"10px 20px", background:C.ink, color:C.bg, border:"none", fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer" }}>
                        결과 보러 가기 →
                      </button>
                    </div>
                  )}
                  {chatMsgs.map((m, i) => (
                    m.role === "system"
                      ? <div key={i} style={{ textAlign:"center", margin:"10px 0 16px" }}>
                          <p style={{ fontSize:11, color:C.dim, background:C.paper, display:"inline-block", padding:"7px 14px", border:`1px solid ${C.rule}`, lineHeight:1.7, whiteSpace:"pre-line" }}>{m.text}</p>
                        </div>
                      : <Bubble key={i} role={m.role === "user" ? "user" : "ai"} text={m.text} name="지현" emoji="🌙" />
                  ))}
                  {chatBusy && <Typing name="지현" emoji="🌙" />}
                </div>
                <div style={{ padding:"7px 18px", borderTop:`1px solid ${C.rule}`, background:"rgba(249,245,239,.97)", flexShrink:0 }}>
                  <p style={{ fontSize:10, color:C.gold, letterSpacing:".1em", textTransform:"uppercase", marginBottom:4 }}>소울 추천 질문</p>
                  <p onClick={() => sendChat("버려진다는 느낌, 언제 처음 받았어요?")} style={{ fontSize:11, color:C.dim, cursor:"pointer" }}>"버려진다는 느낌, 언제 처음 받았어요?" →</p>
                </div>
                <div style={{ padding:"10px 16px", borderTop:`1px solid ${C.rule}`, background:"rgba(249,245,239,.97)", display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !chatBusy && !e.nativeEvent.isComposing) sendChat(); }}
                    placeholder="지현에게 메시지..."
                    style={{ flex:1, border:`1px solid ${C.rule}`, background:C.bg, padding:"11px 13px", fontSize:13, color:C.ink }} />
                  <button onClick={() => sendChat()} disabled={chatBusy}
                    style={{ background:chatBusy ? "rgba(26,17,8,.25)" : C.ink, color:C.bg, border:"none", padding:"11px 16px", fontSize:10, letterSpacing:".1em", textTransform:"uppercase", cursor:chatBusy ? "not-allowed" : "pointer", flexShrink:0 }}>
                    {chatBusy ? "..." : "전송"}
                  </button>
                </div>
                <BNav tab={tab} onSwitch={setTab} notif={notif} pct={pct} onLocked={showToast} />
              </div>
            )}

            {/* 나 탭 */}
            {tab === "me" && (
              <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden" }}>
                <div style={{ height:50, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 18px", borderBottom:`1px solid ${C.rule}`, flexShrink:0 }}>
                  <span />
                  <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:19 }}>나의 소울</span>
                  <span style={{ fontSize:11, color:C.dim }}>설정</span>
                </div>
                <div style={{ flex:1, overflowY:"auto", padding:"16px 18px" }}>
                  <div style={{ textAlign:"center", padding:"20px 0 16px" }}>
                    <div style={{ position:"relative", width:72, height:72, margin:"0 auto 12px" }}>
                      <div style={{ width:72, height:72, borderRadius:"50%", background:"rgba(90,154,122,.2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:30 }}>🌿</div>
                      <div style={{ position:"absolute", bottom:0, right:0, width:20, height:20, borderRadius:"50%", background:C.soul, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, color:"#fff", fontWeight:500 }}>{pct}</div>
                    </div>
                    <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:26, marginBottom:3 }}>{nick}</p>
                    <p style={{ fontSize:11, color:C.dim }}>{getMode(pct)} · {vec?.core_emotion || "분석 중"}</p>
                  </div>
                  <div style={{ marginBottom:14 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                      <span style={{ fontSize:10, color:C.dim, letterSpacing:".12em", textTransform:"uppercase" }}>소울 진행도</span>
                      <span style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:13, color:C.soul }}>{pct}%</span>
                    </div>
                    <div style={{ height:3, background:C.rule }}><div style={{ height:"100%", width:`${pct}%`, background:C.soul, transition:"width .8s" }} /></div>
                    <p style={{ fontSize:10, color:C.dim, marginTop:4 }}>30% 달성 시 매칭 가능</p>
                  </div>
                  <div style={{ background:C.paper, border:`1px solid ${C.rule}`, padding:14, marginBottom:12 }}>
                    <p style={{ fontSize:9, color:C.dim, letterSpacing:".12em", textTransform:"uppercase", marginBottom:10 }}>나의 페르소나</p>
                    {vec?.core_emotion ? (
                      <>
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>
                          {[["핵심 감정", vec.core_emotion], ["애착 유형", vec.attachment === "anxious" ? "불안형" : vec.attachment === "avoidant" ? "회피형" : "안정형"], ["두려움", vec.fear || "?"], ["빛남", vec.shine || "?"]].map(([k,v]) => (
                            <div key={k} style={{ padding:"8px 10px", background:C.bg }}>
                              <p style={{ fontSize:9, color:C.dim, letterSpacing:".1em", textTransform:"uppercase", marginBottom:3 }}>{k}</p>
                              <p style={{ fontSize:12 }}>{v}</p>
                            </div>
                          ))}
                        </div>
                        <div style={{ padding:12, background:C.ink, color:C.bg }}>
                          <p style={{ fontSize:10, color:C.gold, letterSpacing:".1em", textTransform:"uppercase", marginBottom:7 }}>소울의 분석</p>
                          <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:13, lineHeight:1.85 }}>{nick}은 {vec.core_emotion} 감정이 핵심인 사람이에요. {vec.fear}을 두려워하지만, {vec.shine}에서 가장 빛나요.</p>
                        </div>
                      </>
                    ) : (
                      <p style={{ fontSize:12, color:C.dim, textAlign:"center", padding:"20px 0" }}>소울과 5번 이상 대화하면<br/>페르소나가 분석돼요</p>
                    )}
                  </div>
                  <button onClick={() => setTab("soul")}
                    style={{ width:"100%", padding:12, background:C.ink, color:C.bg, border:"none", fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer", fontWeight:500 }}>
                    소울과 대화하기 →
                  </button>
                </div>
                <BNav tab={tab} onSwitch={setTab} notif={notif} pct={pct} onLocked={showToast} />
              </div>
            )}

            {/* 결과 시트 */}
            {showSheet && sheetCard && (
              <div onClick={() => setShowSheet(false)}
                style={{ position:"absolute", inset:0, background:"rgba(26,17,8,.5)", display:"flex", flexDirection:"column", justifyContent:"flex-end", zIndex:20, animation:"up .2s ease" }}>
                <div onClick={e => e.stopPropagation()}
                  style={{ background:C.bg, borderRadius:"16px 16px 0 0", maxHeight:"88%", display:"flex", flexDirection:"column" }}>
                  <div style={{ width:36, height:3, background:C.rule, borderRadius:99, margin:"14px auto 12px" }} />
                  <div style={{ padding:"0 18px 12px", flexShrink:0 }}>
                    <div style={{ display:"flex", gap:12, alignItems:"center", marginBottom:14 }}>
                      <div style={{ width:46, height:46, borderRadius:"50%", background:"rgba(200,144,106,.18)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:23 }}>{sheetCard.emoji}</div>
                      <div style={{ flex:1 }}>
                        <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:21, marginBottom:2 }}>{sheetCard.name}</p>
                        <p style={{ fontSize:11, color:C.dim }}>말없이 통하는 고요함</p>
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:30, color:sheetCard.tc }}>{sheetCard.score}</p>
                        <p style={{ fontSize:10, color:sheetCard.tc }}>{sheetCard.tier}</p>
                      </div>
                    </div>
                    <div style={{ display:"flex", border:`1px solid ${C.rule}` }}>
                      {["overview","conv","sim"].map(t => (
                        <button key={t} onClick={() => setSheetTab(t)}
                          style={{ flex:1, padding:"8px 0", background:sheetTab===t?C.ink:"transparent", color:sheetTab===t?C.bg:C.dim, border:"none", fontSize:10, letterSpacing:".1em", textTransform:"uppercase", cursor:"pointer" }}>
                          {t === "overview" ? "개요" : t === "conv" ? "대화" : "100년"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ padding:"12px 18px", overflowY:"auto", flex:1 }}>
                    {sheetTab === "overview" && (
                      <>
                        <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}>
                          <svg width="96" height="96" style={{ transform:"rotate(-90deg)" }}>
                            <circle cx="48" cy="48" r="42" fill="none" stroke="rgba(26,17,8,.07)" strokeWidth="3"/>
                            <circle cx="48" cy="48" r="42" fill="none" stroke={sheetCard.tc} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${sheetCard.score*2.64} 264`}/>
                          </svg>
                        </div>
                        <div style={{ padding:"10px 12px", background:"rgba(200,112,80,.06)", borderLeft:"3px solid rgba(200,112,80,.32)", marginBottom:10 }}>
                          <p style={{ fontSize:10, color:C.dim, letterSpacing:".1em", textTransform:"uppercase", marginBottom:5 }}>소울의 판단</p>
                          <p style={{ fontSize:12, color:C.ink, lineHeight:1.75 }}>두 페르소나가 같은 두려움에서 출발했지만 서로 다른 방식으로 해결해왔어요.</p>
                        </div>
                      </>
                    )}
                    {sheetTab === "conv" && (
                      <>
                        <p style={{ fontSize:10, color:C.dim, letterSpacing:".1em", textTransform:"uppercase", marginBottom:10 }}>페르소나 대화 하이라이트</p>
                        {[["user","안녕하세요. 어색하네요..."],["ai","저도요 ㅎ 그냥 편하게 얘기해요"],["user","그게 잘 안 돼요. 처음 보는 사람한테"],["ai","지금 이렇게 솔직하게 말하잖아요. 이미 시작된 거예요"]].map(([r,t],i) => (
                          <div key={i} style={{ display:"flex", justifyContent:r==="user"?"flex-end":"flex-start", marginBottom:8 }}>
                            <div style={{ background:r==="user"?C.ink:C.paper, color:r==="user"?C.bg:C.ink, border:r==="ai"?`1px solid ${C.rule}`:"none", padding:"8px 11px", fontSize:12, maxWidth:"80%" }}>{t}</div>
                          </div>
                        ))}
                      </>
                    )}
                    {sheetTab === "sim" && (
                      <>
                        <p style={{ fontSize:10, color:C.dim, letterSpacing:".1em", textTransform:"uppercase", marginBottom:10 }}>100년 이야기 미리보기</p>
                        {[["처음 만남","말을 멈추자 상대가 침묵을 깨지 않았다.",false],["첫 번째 봄","같은 두려움을 다른 방식으로 품고 있었다.",false],["3년 후",null,true],["10년 후",null,true]].map(([title,text,locked],i) => (
                          <div key={i} style={{ borderLeft:`1px solid ${C.rule}`, marginLeft:8, paddingLeft:14, marginBottom:10, position:"relative", opacity:locked?0.5:1 }}>
                            <div style={{ position:"absolute", left:-4, top:6, width:7, height:7, borderRadius:"50%", background:C.bg, border:`1px solid ${C.gold}` }} />
                            <p style={{ ...serif, fontFamily:"'Cormorant Garamond',Georgia,serif", fontSize:13, marginBottom:2 }}>{title}</p>
                            <p style={{ fontSize:11, color:C.dim, lineHeight:1.65 }}>{locked ? "🔒 수락 후 공개" : `"${text}"`}</p>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                  <div style={{ padding:"12px 18px", borderTop:`1px solid ${C.rule}`, flexShrink:0 }}>
                    <div style={{ display:"flex", gap:9 }}>
                      <button onClick={() => { setShowSheet(false); showToast("거절했어요"); }}
                        style={{ flex:1, padding:11, background:"transparent", color:C.dim, border:`1px solid ${C.rule}`, fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer" }}>거절</button>
                      <button onClick={acceptMatch}
                        style={{ flex:1, padding:12, background:C.ink, color:C.bg, border:"none", fontSize:10, letterSpacing:".12em", textTransform:"uppercase", cursor:"pointer", fontWeight:500 }}>수락하고 대화 시작 ✦</button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* 토스트 */}
        {toast && (
          <div style={{ position:"absolute", bottom:80, left:"50%", transform:"translateX(-50%)", background:C.ink, color:C.bg, padding:"10px 18px", fontSize:12, whiteSpace:"nowrap", zIndex:30, animation:"up .3s ease", pointerEvents:"none" }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
