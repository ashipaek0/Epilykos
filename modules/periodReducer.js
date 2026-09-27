const { SQL_LOCAL_DAY } = require('./localTime');
const isoDay = (date, timezone) => new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
function shiftDay(day, delta) { const [y,m,d]=day.split('-').map(Number); return new Date(Date.UTC(y,m-1,d+delta)).toISOString().slice(0,10); }
function periodBounds(period, now=new Date(), timezone=Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const today=isoDay(now,timezone), [y,m]=today.split('-').map(Number); let start=today,end=shiftDay(today,1);
  if(period==='month'){start=`${y}-${String(m).padStart(2,'0')}-01`;end=m===12?`${y+1}-01-01`:`${y}-${String(m+1).padStart(2,'0')}-01`;}
  else if(period==='year'){start=`${y}-01-01`;end=`${y+1}-01-01`;}
  else if(period==='since-install') start=null; else if(period!=='today') throw new Error(`Unsupported period: ${period}`);
  return {start,end,today,timezone};
}
function reduceDailyRows(rows,{period='today',now=new Date(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone,metric,coverageStart,installDate}={}) {
  const bounds=periodBounds(period,now,timezone); if(period==='since-install') bounds.start=installDate||null;
  if(!bounds.start) return {status:'insufficient-history',label:'Insufficient history',value:null,coverageStart:coverageStart||null,coverageEnd:null,...bounds};
  const relevant=(rows||[]).filter(r=>r.day>=bounds.start&&r.day<bounds.end), coverageEnd=relevant.length?relevant[relevant.length-1].day:null;
  const expectedEnd=period==='today'?bounds.start:shiftDay(bounds.end,-1), covered=coverageStart&&coverageStart<=bounds.start&&coverageEnd===expectedEnd;
  if(!covered) return {status:'insufficient-history',label:'Insufficient history',value:null,coverageStart:coverageStart||null,coverageEnd,...bounds};
  const value=relevant.reduce((sum,r)=>{const n=Number(r[metric]);return sum+(Number.isFinite(n)&&n>=0?n:0);},0);
  return {status:'complete',value,coverageStart:bounds.start,coverageEnd:expectedEnd,...bounds};
}
function financialValue(formula,sum,{monthlyRate,yearlyOffset,yearlyRate,generatorOffset,generatorRate,roiBaseline}={}) {
  if(!Number.isFinite(sum)||sum<0) return null;
  if(formula==='monthly-grid-savings') return sum*Number(monthlyRate);
  if(formula==='yearly-grid-savings') return (sum+Number(yearlyOffset))*Number(yearlyRate);
  if(formula==='generator-savings'||formula==='generator-roi') {const savings=(sum+Number(generatorOffset))*Number(generatorRate);return formula==='generator-roi'?savings-Number(roiBaseline):savings;}
  throw new Error(`Unsupported formula: ${formula}`);
}
module.exports={SQL_LOCAL_DAY,periodBounds,reduceDailyRows,financialValue,shiftDay};
