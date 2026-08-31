import fs from 'fs';
const src = fs.readFileSync('emailer.js','utf8');
// Plocka ut parseBetyg + starRating (esc stubbas)
const pb = src.slice(src.indexOf('function parseBetyg(v) {'), src.indexOf('// Medel av Grade.Värde'));
const sr = src.slice(src.indexOf('function starRating(v) {'));
const srBody = sr.slice(0, sr.indexOf('\n}\n')+3);
const mod = new Function('esc', pb + srBody + '; return {parseBetyg, starRating};')(s=>String(s));
const {parseBetyg, starRating} = mod;

let fails=0;
function eq(label, got, exp){ const ok=got===exp; if(!ok){fails++;} console.log((ok?'PASS':'FAIL')+'  '+label+(ok?'':'\n   fick '+JSON.stringify(got)+' vantade '+JSON.stringify(exp))); }

console.log('--- parseBetyg ---');
eq('tal 4',            parseBetyg(4), 4);
eq('strang "4"',       parseBetyg('4'), 4);
eq('decimalkomma "4,5"',parseBetyg('4,5'), 4.5);
eq('decimalpunkt "4.5"',parseBetyg('4.5'), 4.5);
eq('"4/5"',            parseBetyg('4/5'), 4);
eq('"4 av 5"',         parseBetyg('4 av 5'), 4);
eq('"8/10" -> 5-skala', parseBetyg('8/10'), 4);
eq('Bubble-id AVVISAS', parseBetyg('1760448796514x199282234734132770'), null);
eq('ren text avvisas',  parseBetyg('Nivå 3'), null);
eq('"Mycket bra" avvisas', parseBetyg('Mycket bra'), null);
eq('tomt',             parseBetyg(''), null);
eq('null',             parseBetyg(null), null);
eq('utanfor skala 7',  parseBetyg(7), null);
eq('0',                parseBetyg(0), 0);

console.log('\n--- starRating ---');
const r45 = starRating(4.5);
eq('4,5 visar "4,5/5"', /4,5\/5/.test(r45), true);
eq('4,5 ger 5 stjarnor', (r45.match(/★/g)||[]).length, 5);
eq('4,5 fyller 5 (avrundat)', (r45.match(/#f59e0b/g)||[]).length, 5);
eq('4 fyller 4', (starRating(4).match(/#f59e0b/g)||[]).length, 4);
eq('otolkbart -> ratexten, INGA stjarnor', starRating('Nivå 3').includes('★'), false);
eq('otolkbart -> visar texten', starRating('Nivå 3').includes('Nivå 3'), true);
eq('Bubble-id -> inga stjarnor', starRating('1760448796514x199282234734132770').includes('★'), false);
eq('tomt -> tom strang', starRating(''), '');

console.log('\n--- REGRESSION: gamla buggen far INTE aterkomma ---');
eq('"4,5" ger INTE 0/5', /0\/5/.test(starRating('4,5')), false);
eq('"Nivå 3" ger INTE 0/5', /0\/5/.test(starRating('Nivå 3')), false);
eq('Bubble-id ger INTE 5/5', /5\/5/.test(starRating('1760448796514x199282234734132770')), false);

console.log(fails? '\n'+fails+' FEL' : '\nALLA GRONA');
process.exit(fails?1:0);
