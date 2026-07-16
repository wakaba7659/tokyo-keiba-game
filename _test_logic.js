// tokyo_keiba.html のロジック部を抽出して検証するテストハーネス
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const m = html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/);
if(!m){ console.error("NG: scriptブロックが見つからない"); process.exit(1); }
const js = m[1];

// ブラウザAPIスタブ
global.window = { addEventListener(){}, AudioContext: undefined, devicePixelRatio: 1 };
global.document = {
  querySelector(){ return null; },
  querySelectorAll(){ return []; },
  createElement(){ return { getContext(){ return new Proxy({}, {get:()=>()=>{}}) }, width:0, height:0 }; },
  addEventListener(){}
};
global.performance = { now: ()=>Date.now() };
global.requestAnimationFrame = ()=>{};
global.ResizeObserver = class { observe(){} };

const jockeysJs = fs.readFileSync(__dirname + "/jockeys.js", "utf8");

// 構文チェックを兼ねて評価（関数スコープ内でevalし、必要な参照を返す）
const {RaceGen, RaceSim, Bets, makeCourse, genCombos, comboHit, comboOdds, ParadeSim} = (function(){
  return eval(jockeysJs + "\n" + js + "\n;({RaceGen, RaceSim, Bets, makeCourse, genCombos, comboHit, comboOdds, ParadeSim});");
})();

let fails = 0;
const check = (name, ok, detail)=>{
  console.log((ok?"OK ":"NG ") + name + (detail?("  "+detail):""));
  if(!ok) fails++;
};

// ---- コースジオメトリ ----
for(const surf of ["turf","dirt"]){
  const c = makeCourse(surf);
  const p0 = c.point2d(0), pL = c.point2d(c.L);
  check(`${surf}: 周回閉合`, Math.hypot(p0.x-pL.x, p0.y-pL.y) < 0.01);
  if(surf==="turf") check("芝1周 = 2083.1m", Math.abs(c.L-2083.1)<0.01, `L=${c.L.toFixed(1)}`);
  check(`${surf}: ゴール前直線525.9m`, Math.abs(c.FINISH-525.9)<0.01);
  // 高低差: 最大約2m、連続性
  let hMin=1e9,hMax=-1e9,maxJump=0,prev=c.elev(0);
  for(let s=0;s<=c.L;s+=2){
    const h=c.elev(s);
    hMin=Math.min(hMin,h); hMax=Math.max(hMax,h);
    maxJump=Math.max(maxJump,Math.abs(h-prev)); prev=h;
  }
  check(`${surf}: 高低差≈2m`, hMax-hMin>1.8 && hMax-hMin<2.2, `range=${(hMax-hMin).toFixed(2)}`);
  check(`${surf}: 標高が連続`, maxJump<0.05, `maxJump=${maxJump.toFixed(3)}`);
  // だんだら坂: 残り460→300mが上り
  const s460 = ((c.FINISH-460)%c.L+c.L)%c.L, s300=((c.FINISH-300)%c.L+c.L)%c.L;
  check(`${surf}: 残り460-300mは上り坂`, c.elev(s300)>c.elev(s460)+1.5);
}

// ---- レース生成・シミュレーション ----
const N = 400;
let headOk=0, timesOk=0, nanBad=0, favWins=0, payoutBad=0;
const styleWins = {turf:[0,0,0,0], dirt:[0,0,0,0]};
const styleRuns = {turf:[0,0,0,0], dirt:[0,0,0,0]};
const timeSamples = {};
for(let i=0;i<N;i++){
  const race = RaceGen.make(i+1);
  if(race.count<9 || race.count>18){ check("頭数9-18", false, String(race.count)); }
  else headOk++;
  const course = makeCourse(race.surface);
  const sim = new RaceSim(race, course);
  const order = sim.runToEnd();
  if(order.length<3){ check("3着まで確定", false); continue; }
  const t1 = sim.horses[order[0]-1].time;
  if(!isFinite(t1) || order.some(n=>!isFinite(sim.horses[n-1].time))) nanBad++;
  // タイム妥当性: 平均速度 15.5〜18.5 m/s
  const v = race.dist/t1;
  if(v>15.0 && v<18.8) timesOk++;
  (timeSamples[race.surface+race.dist] ||= []).push(t1);
  if(race.horses[order[0]-1].pop===1) favWins++;
  styleWins[race.surface][race.horses[order[0]-1].style]++;
  race.horses.forEach(h=>styleRuns[race.surface][h.style]++);
  // オッズ・払戻の健全性
  const [f1,f2] = order;
  const q = RaceGen.oddsQuinella(race,f1,f2), e = RaceGen.oddsExacta(race,f1,f2);
  if(!(q>=1.1 && e>=1.1 && isFinite(q) && isFinite(e))) payoutBad++;
}
check(`頭数レンジ (${headOk}/${N})`, headOk===N);
check(`タイム妥当 (${timesOk}/${N})`, timesOk>N*0.97);
check("NaNなし", nanBad===0, `bad=${nanBad}`);
check(`1番人気勝率 20-45%`, favWins/N>0.20 && favWins/N<0.45, (favWins/N*100).toFixed(1)+"%");
check("組オッズ健全", payoutBad===0);

// 脚質×馬場傾向: 芝は差し追込、ダートは逃げ先行が相対的に有利
const rate = (o,s)=> (styleWins[o][s]+styleWins[o][s===0?1:s===3?2:s]) / 1; // raw
const frontRate = (o)=> (styleWins[o][0]+styleWins[o][1]+(styleWins[o][4]||0)) / Math.max(1,(styleRuns[o][0]+styleRuns[o][1]+(styleRuns[o][4]||0)));
const closeRate = (o)=> (styleWins[o][2]+styleWins[o][3]) / Math.max(1,(styleRuns[o][2]+styleRuns[o][3]));
console.log(`  芝: 前(逃/先)勝率/頭=${(frontRate("turf")*100).toFixed(2)}% 後(差/追)=${(closeRate("turf")*100).toFixed(2)}%`);
console.log(`  ダ: 前(逃/先)勝率/頭=${(frontRate("dirt")*100).toFixed(2)}% 後(差/追)=${(closeRate("dirt")*100).toFixed(2)}%`);
check("芝: 差し・追込が届く", closeRate("turf") >= frontRate("turf")*0.85);
check("ダート: 前が止まりにくい", frontRate("dirt") > closeRate("dirt"));
const dirtFrontBias = frontRate("dirt")/Math.max(0.0001,closeRate("dirt"));
const turfFrontBias = frontRate("turf")/Math.max(0.0001,closeRate("turf"));
check("ダートは芝より前有利", dirtFrontBias > turfFrontBias);

// 代表距離の平均タイム
for(const k of Object.keys(timeSamples).sort()){
  const arr = timeSamples[k];
  const avg = arr.reduce((a,b)=>a+b,0)/arr.length;
  console.log(`  ${k}m 平均タイム: ${Math.floor(avg/60)}:${(avg%60).toFixed(1)} (n=${arr.length})`);
}

// ---- G1（11R）: オッズが極端になりにくい ----
{
  const stat = (rounds)=>{
    let fav=0, max=0, n=120;
    for(let i=0;i<n;i++){
      const r = RaceGen.make(rounds);
      const odds = r.horses.map(h=>h.oddsWin);
      fav += Math.min(...odds); max += Math.max(...odds);
    }
    return {fav:fav/n, max:max/n};
  };
  const g1 = stat(11), norm = stat(3);
  const r11 = RaceGen.make(11), r23 = RaceGen.make(23), r3 = RaceGen.make(3);
  check("11RはGI", r11.klass==="GI" && r11.isG1 && r11.rNo===11);
  check("23R（翌日11R）もGI", r23.klass==="GI" && r23.rNo===11);
  check("通常レースはGIでない", !r3.isG1);
  check("GIは多頭数(15-18)", r11.count>=15 && r11.count<=18);
  console.log(`  GI: 1人気平均${g1.fav.toFixed(1)}倍/最大平均${g1.max.toFixed(0)}倍  通常: ${norm.fav.toFixed(1)}倍/${norm.max.toFixed(0)}倍`);
  check("GIは大穴が出にくい（最大オッズ圧縮）", g1.max < norm.max*0.55);
  check("GIは1本かぶりになりにくい", g1.fav > norm.fav*1.15);
}

// ---- 新券種・買い方（点数と的中判定）----
check("馬連ボックス4頭=6点", genCombos("quinella","box",[[1,2,3,4]]).length===6);
check("三連単ボックス4頭=24点", genCombos("trifecta","box",[[1,2,3,4]]).length===24);
check("三連複ながし 軸1+相手4頭=6点", genCombos("trio","nagashi",[[1],[2,3,4,5]]).length===6);
check("三連単ながし 軸1着+相手3頭=6点", genCombos("trifecta","nagashi",[[1],[2,3,4]]).length===6);
check("馬単フォーメーション 2×3=4点", genCombos("exacta","form",[[1,2],[1,2,3]]).length===4);
check("三連単フォーメーション=4点", genCombos("trifecta","form",[[1],[2,3],[2,3,4]]).length===4);
check("ワイドながし 軸1+相手3頭=3点", genCombos("wide","nagashi",[[1],[2,3,4]]).length===3);
check("ワイド的中判定", comboHit("wide",[2,9],[9,4,2]) && !comboHit("wide",[2,5],[9,4,2]));
check("三連複的中判定", comboHit("trio",[1,3,5],[5,1,3]) && !comboHit("trio",[1,3,6],[5,1,3]));
check("三連単的中判定", comboHit("trifecta",[5,1,3],[5,1,3]) && !comboHit("trifecta",[1,5,3],[5,1,3]));

// Harville整合: 三連複の全組合せ確率の総和 ≈ 1
{
  const r = RaceGen.make(3);
  let s = 0;
  for(let a=1;a<=r.count;a++)for(let b=a+1;b<=r.count;b++)for(let c=b+1;c<=r.count;c++) s += RaceGen.trioP(r,a,b,c);
  check("三連複確率の総和≈1", Math.abs(s-1)<0.08, s.toFixed(3));
  const [x,y,z] = [1,2,3];
  check("新オッズが健全", RaceGen.oddsWide(r,x,y)>=1.1 && RaceGen.oddsTrio(r,x,y,z)>=1.1 && RaceGen.oddsTrifecta(r,x,y,z)>=1.1);
}

// ---- 実在G1・開催日制 ----
{
  const r11 = RaceGen.make(11);
  check("1日目11R=フェブラリーS(ダ1600)", r11.name.includes("フェブラリー") && r11.surface==="dirt" && r11.dist===1600);
  const r23 = RaceGen.make(23);
  check("2日目11R=NHKマイルC(芝1600・3歳)", r23.name.includes("NHKマイル") && r23.surface==="turf" && r23.dist===1600 && r23.horses.every(h=>h.sexAge.endsWith("3")));
  const oaks = RaceGen.make(11+12*3);
  check("4日目11R=オークス(牝3・芝2400)", oaks.name.includes("オークス") && oaks.horses.every(h=>h.sexAge==="牝3") && oaks.dist===2400);
  const r13 = RaceGen.make(13);
  check("12Rの次は翌日1R", r13.rNo===1 && r13.day===2);
}

// ---- 本馬場入場 ----
{
  const race = RaceGen.make(2);
  const course = makeCourse(race.surface);
  const p = new ParadeSim(race, course);
  for(let i=0;i<600;i++) p.step(1/30); // 20秒
  const snap = p.snapshot();
  check("入場馬が動いている", snap.horses.some(h=>h.v>2));
  check("入場スナップショット健全", snap.horses.every(h=>isFinite(h.trackS)&&isFinite(h.lane)&&isFinite(h.angOff)));
}

// ---- 払戻計算 ----
check("100円×3.6倍=360円", Bets.calcPayout(100,3.6)===360);
check("500円×12.3倍=6150円", Bets.calcPayout(500,12.3)===6150);
check("10円未満切捨て(1.15倍)", Bets.calcPayout(100,1.15)===110);

console.log(fails===0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails===0?0:1);
