'use strict';
const SWARA_SEMI={'S':0,'R1':1,'R2':2,'R3':4,'G1':2,'G2':4,'G3':5,'M1':5,'M2':6,'P':7,'D1':8,'D2':9,'D3':10,'N1':10,'N2':11,'N3':12,'S.':12};
const SWARA_DISPLAY={'S':'Sa','R1':'Ri1','R2':'Ri2','R3':'Ri3','G1':'Ga1','G2':'Ga2','G3':'Ga3','M1':'Ma1','M2':'Ma2','P':'Pa','D1':'Dha1','D2':'Dha2','D3':'Dha3','N1':'Ni1','N2':'Ni2','N3':'Ni3','S.':'Sa\''};
const NOTE_STEPS=['C','C','D','D','E','F','F','G','G','A','A','B'];
const NOTE_ALTER=[0,1,0,1,0,0,1,0,1,0,1,0];
const MIDI_PROG={veena:24,sitar:104,flute:73,violin:40,mridangam:117,tabla:115,ghatam:113,harmonium:20,sarangi:110,saxophone:65,piano:0,guitar:25,bass:32,trumpet:56,kanjira:112,drone:23,tampura:23,keyboard:3};
const RAGA_DEMO_LYRICS={
  'Mechakalyani':{pallavi:'\u0c15\u0c32\u0c4d\u0c2f\u0c3e\u0c23\u0c3f \u0c30\u0c3e\u0c17\u0c2e\u0c41 \u0c28\u0c35 \u0c30\u0c38\u0c2e\u0c41\u0c32 \u0c28\u0c3f\u0c32\u0c2f\u0c02',anupallavi:'\u0c2e\u0c47\u0c1a \u0c15\u0c33\u0c4d\u0c2f\u0c3e\u0c23\u0c3f \u0c2e\u0c47\u0c33\u0c15\u0c30\u0c4d\u0c24 \u0c30\u0c3e\u0c17\u0c02',charanam:'\u0c38\u0c2a\u0c4d\u0c24 \u0c38\u0c4d\u0c35\u0c30\u0c3e\u0c32 \u0c38\u0c02\u0c17\u0c2e\u0c02 \u0c36\u0c3e\u0c36\u0c4d\u0c35\u0c24 \u0c38\u0c02\u0c17\u0c40\u0c24\u0c02',swaras_pallavi:'S R2 G3 M2 P D2 N3 S',swaras_anupallavi:'S N3 D2 P M2 G3 R2 S',swaras_charanam:'N3 S R2 G3 M2 P D2 N3 S'},
  'Harikamboji':{pallavi:'\u0c39\u0c30\u0c3f\u0c15\u0c3e\u0c02\u0c2d\u0c4b\u0c1c\u0c3f \u0c39\u0c30\u0c3f \u0c28\u0c3e\u0c2e \u0c38\u0c02\u0c15\u0c40\u0c30\u0c4d\u0c24\u0c28\u0c02',anupallavi:'\u0c2a\u0c02\u0c1a\u0c2e \u0c2a\u0c4d\u0c30\u0c3f\u0c2f \u0c30\u0c3e\u0c17\u0c02 \u0c2a\u0c3e\u0c35\u0c28 \u0c15\u0c33\u0c4d\u0c2f\u0c3e\u0c23\u0c02',charanam:'\u0c15\u0c2e\u0c4d\u0c2c\u0c4b\u0c21\u0c3f \u0c06\u0c32\u0c3e\u0c2a\u0c28 \u0c15\u0c30\u0c4d\u0c23\u0c3e\u0c28\u0c02\u0c26 \u0c2e\u0c3e\u0c27\u0c41\u0c30\u0c40',swaras_pallavi:'S R2 G3 M1 P D2 N2 S',swaras_anupallavi:'S N2 D2 P M1 G3 R2 S',swaras_charanam:'P D2 N2 S R2 G3 M1 P'},
  'Mohanam':{pallavi:'\u0c2e\u0c4b\u0c39\u0c28 \u0c30\u0c3e\u0c17 \u0c2e\u0c3e\u0c27\u0c41\u0c30\u0c3f \u0c2e\u0c28\u0c38\u0c41 \u0c26\u0c4b\u0c1a\u0c41',anupallavi:'\u0c28\u0c3f\u0c28\u0c4d\u0c28\u0c41 \u0c15\u0c4b\u0c30\u0c3f \u0c2e\u0c4b\u0c39\u0c28\u0c02 \u0c28\u0c3f\u0c24\u0c4d\u0c2f \u0c38\u0c02\u0c17\u0c40\u0c24\u0c02',charanam:'\u0c2a\u0c02\u0c1a\u0c24\u0c02\u0c24\u0c4d\u0c30 \u0c35\u0c3e\u0c26\u0c4d\u0c2f \u0c35\u0c3f\u0c28\u0c4b\u0c26 \u0c38\u0c41\u0c16\u0c26\u0c3e\u0c2f\u0c3f',swaras_pallavi:'S R2 G3 P D2 S',swaras_anupallavi:'S D2 P G3 R2 S',swaras_charanam:'G3 P D2 S R2 G3'},
  'Bhairavi':{pallavi:'\u0c2d\u0c48\u0c30\u0c35\u0c3f \u0c30\u0c3e\u0c17 \u0c2d\u0c3e\u0c35\u0c28 \u0c2d\u0c15\u0c4d\u0c24\u0c3f \u0c2a\u0c42\u0c30\u0c4d\u0c23\u0c02',anupallavi:'\u0c36\u0c4d\u0c30\u0c40 \u0c15\u0c30\u0c2e\u0c48\u0c28 \u0c2e\u0c3e\u0c24 \u0c38\u0c47\u0c35 \u0c1a\u0c47\u0c2f\u0c41\u0c1f\u0c15\u0c41',charanam:'\u0c2e\u0c02\u0c17\u0c33 \u0c15\u0c30\u0c2e\u0c48\u0c28 \u0c30\u0c3e\u0c17 \u0c2e\u0c3e\u0c30\u0c4d\u0c17\u0c02 \u0c36\u0c30\u0c23\u0c02',swaras_pallavi:'S R2 G2 M1 P D1 N2 S',swaras_anupallavi:'S N2 D1 P M1 G2 R2 S',swaras_charanam:'M1 P D1 N2 S R2 G2 M1'},
  'Hanumatodi':{pallavi:'\u0c39\u0c28\u0c41\u0c2e\u0c24\u0c4b\u0c21\u0c3f \u0c39\u0c30\u0c3f \u0c2a\u0c3e\u0c26 \u0c35\u0c02\u0c26\u0c28\u0c02',anupallavi:'\u0c24\u0c4b\u0c21\u0c3f \u0c30\u0c3e\u0c17 \u0c2d\u0c3e\u0c35\u0c28 \u0c24\u0c2a\u0c4b \u0c2c\u0c32\u0c02',charanam:'\u0c39\u0c28\u0c41\u0c2e \u0c28\u0c3e\u0c2e \u0c38\u0c4d\u0c2e\u0c30\u0c23\u0c02 \u0c39\u0c30\u0c4d\u0c37 \u0c26\u0c3e\u0c2f\u0c15\u0c02',swaras_pallavi:'S R1 G2 M1 P D1 N2 S',swaras_anupallavi:'S N2 D1 P M1 G2 R1 S',swaras_charanam:'P D1 N2 S R1 G2 M1 P'},
  'Kharaharapriya':{pallavi:'\u0c16\u0c30\u0c39\u0c30\u0c2a\u0c4d\u0c30\u0c3f\u0c2f \u0c30\u0c3e\u0c17 \u0c2e\u0c3e\u0c27\u0c41\u0c30\u0c4d\u0c2f\u0c02',anupallavi:'\u0c28\u0c3e\u0c26 \u0c2c\u0c4d\u0c30\u0c39\u0c4d\u0c2e \u0c38\u0c4d\u0c35\u0c30\u0c42\u0c2a\u0c02 \u0c28\u0c3f\u0c24\u0c4d\u0c2f\u0c3e\u0c28\u0c02\u0c26\u0c02',charanam:'\u0c38\u0c02\u0c17\u0c40\u0c24 \u0c38\u0c3e\u0c17\u0c30\u0c02\u0c32\u0c4b \u0c2e\u0c41\u0c28\u0c3f\u0c17\u0c3f \u0c24\u0c47\u0c32\u0c41\u0c1f\u0c15\u0c41',swaras_pallavi:'S R2 G2 M1 P D2 N2 S',swaras_anupallavi:'S N2 D2 P M1 G2 R2 S',swaras_charanam:'M1 P D2 N2 S R2 G2 M1'},
  'bilahari':      {'pallavi':'వాతాపి గణపతిం భజే హం',        'anupallavi':'ఏకదంత శుభ వదనం',            'charanam':'బిలహరి రాగ సుమ ఆరాధనం',       'swaras_pallavi':'S R2 G3 P D2 S',    'swaras_anupallavi':'S N3 D2 P M1 G3 R2 S',  'swaras_charanam':'G3 P D2 N3 S R2 G3 P'},
  'Shanmukhapriya':{'pallavi':'సిద్ధి వినాయకం నమామి',  'anupallavi':'షణ్ముఖ ప్రియ రాగం', 'charanam':'షణ్ముఖ ప్రియ సంగీతం','swaras_pallavi':'S R2 G2 M2 P D1 N2 S','swaras_anupallavi':'S N2 D1 P M2 G2 R2 S','swaras_charanam':'M2 P D1 N2 S R2 G2 M2'},
  'kAnaDA':        {'pallavi':'బాలాంబికాయం భజామి',                'anupallavi':'కాళికా దేవి పాద కమలం','charanam':'కానడ రాగ మనోహరి',               'swaras_pallavi':'S R2 G2 M1 D2 N2 S','swaras_anupallavi':'S N2 D2 P M1 G2 R2 S', 'swaras_charanam':'N2 S R2 G2 M1 D2 N2'},
  'harikAmbhOji':  {'pallavi':'సాకేత నగర నాథ రాఘవ',                    'anupallavi':'సీతా కాంత జగదాధార','charanam':'హరికాంభోజి రాగ మనోహర',  'swaras_pallavi':'S R2 G3 M1 P D2 N2 S','swaras_anupallavi':'S N2 D2 P M1 G3 R2 S', 'swaras_charanam':'M1 P D2 N2 S R2 G3 M1'},
  'kannaDa':       {'pallavi':'సాకేత నికేతన రాఘవ నుత',  'anupallavi':'శ్రీ రామ హరి వారిజ',   'charanam':'కన్నడ రాగ ప్రియ వీణ',      'swaras_pallavi':'G3 R2 S G3 M1 P M1 D2 N3 S','swaras_anupallavi':'S N3 D2 P M1 G3 M1 R2 S','swaras_charanam':'M1 P M1 D2 N3 S G3'},
  'nATA':          {'pallavi':'మహా గణపతిం మనసా స్మరామి','anupallavi':'నాట రాగ వినాయక','charanam':'చాలనాట మేళ జన్య రాగం',       'swaras_pallavi':'S R3 G3 M1 P D3 N3 S','swaras_anupallavi':'S N3 P M1 R3 S',        'swaras_charanam':'N3 S R3 G3 M1 P N3 S'},
  'mOhanA':        {'pallavi':'మోహన రామ మనోహర',                                         'anupallavi':'నిన్నుకోరి మోహనం',     'charanam':'మోహన పంచమ రాగ విలాసం',     'swaras_pallavi':'S R2 G3 P D2 S',    'swaras_anupallavi':'S D2 P G3 R2 S',        'swaras_charanam':'G3 P D2 S R2 G3'},
  'Madhukauns':    {'pallavi':'మధుకౌన్స రాగ మాధురి',          'anupallavi':'హిందుస్తానీ రాగ సుమ','charanam':'పంచమ రహిత రాగం మధురం', 'swaras_pallavi':'S G3 M1 D3 N3 S',   'swaras_anupallavi':'S N3 D3 M1 G3 S',       'swaras_charanam':'G3 M1 D3 N3 S G3'}
};
function _swaraToMidi(sw,octave){const semi=SWARA_SEMI[sw.trim()];if(semi===undefined)return 60;return 60+(octave-4)*12+semi;}
function _midiToXmlNote(midi){const semi=((midi%12)+12)%12;const oct=Math.floor(midi/12)-1;return{step:NOTE_STEPS[semi],alter:NOTE_ALTER[semi],octave:oct};}
function _parseSwaras(str){return(str||'').split(/\s+/).filter(Boolean);}
function _xmlEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function _noteXml(sw,octave,duration,lyric,swaraName){octave=octave||4;duration=duration||4;const midi=_swaraToMidi(sw,octave);const{step,alter,octave:oct}=_midiToXmlNote(midi);const alterXml=alter?`<alter>${alter}</alter>`:'';const lyricXml=lyric?`<lyric number="1"><syllabic>single</syllabic><text>${_xmlEsc(lyric)}</text></lyric>`:'';const lyricSwara=swaraName?`<lyric number="2"><syllabic>single</syllabic><text>${_xmlEsc(swaraName)}</text></lyric>`:'';return`<note><pitch><step>${step}</step>${alterXml}<octave>${oct}</octave></pitch><duration>${duration}</duration><type>quarter</type>${lyricXml}${lyricSwara}</note>`;}
function _buildMeasure(num,swaras,lyrics,header){lyrics=lyrics||[];const direction=header?`<direction placement="above"><direction-type><words font-size="9">${_xmlEsc(header)}</words></direction-type></direction>`:'';const notes=swaras.slice(0,8).map((sw,i)=>_noteXml(sw,4,4,lyrics[i]||'',SWARA_DISPLAY[sw]||sw)).join('');const attrib=num===1?`<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`:'';;return`<measure number="${num}">${attrib}${direction}${notes}</measure>`;}

function generateSheetMusicXml(ragaInfo, compOpts){
  compOpts = compOpts || {};
  const title  = compOpts.title || (ragaInfo.label + ' — GoMaa Raga Vidya');
  const tala   = compOpts.tala  || (ragaInfo.meta_tala && ragaInfo.meta_tala.name) || 'Adi';

  // AUDIO-ONLY policy: never use demo/KB/pretrained lyrics
  // Content comes from: compOpts.transcription (faster-whisper) + compOpts.pitchFrames (YIN)
  const xcrip  = compOpts.transcription || null;
  const pitchFr= compOpts.pitchFrames   || null;

  // Split transcription into sections
  function splitText(text, n){
    if(!text) return Array(n).fill('');
    const words = text.trim().split(/\s+/);
    const sz = Math.ceil(words.length/n);
    return Array.from({length:n},(_,i)=>words.slice(i*sz,(i+1)*sz).join(' '));
  }
  const _full = xcrip ? (xcrip.full || '') : '';
  const parts = xcrip
    ? [xcrip.pallavi||'', xcrip.anupallavi||'', xcrip.charanam||'']
    : splitText(_full, 3);
  const [_pal, _anu, _cha] = parts;

  // Real notes from audio pitchFrames
  let _realNotes = null;
  if(pitchFr && pitchFr.length > 0){
    const voiced = pitchFr.filter(function(f){return f&&f.freq>140&&(f.clarity||0)>0.4;});
    const deduped=[]; let prev=null, ct=0;
    for(const f of voiced){
      if(f.swara!==prev){if(prev!==null)deduped.push({sw:prev,n:ct});prev=f.swara;ct=1;}
      else ct++;
    }
    if(prev)deduped.push({sw:prev,n:ct});
    _realNotes = deduped.slice(0,64).map(function(x){return x.sw;});
  }

  const aroha   = _parseSwaras(ragaInfo.aroha   || 'S R G M P D N S');
  const avaroha = _parseSwaras(ragaInfo.avaroha  || 'S N D P M G R S');
  function notesFor(fb){ return _realNotes ? _realNotes.slice(0,8) : fb; }
  const swP = notesFor(aroha), swAp = notesFor(avaroha), swCh = notesFor(aroha);
  function sylls(t){ return (t||'').split(/[\s|]+/).filter(Boolean); }
  function sw2name(s){ return SWARA_DISPLAY[s]||s; }

  let mn=1;
  function m(sw,lyr,hdr){ return _buildMeasure(mn++,sw,lyr,hdr); }
  const hasLyr = function(t){ return sylls(t).length>0; };

  const measures=[
    m(aroha,   aroha.map(sw2name),                                     'Arohanam — Scale Reference'),
    m(avaroha, avaroha.map(sw2name),                                   'Avarohanam — Scale Reference'),
    m(swP,     swP.map(sw2name),                                       'Pallavi — Swaras'),
    m(swP,     hasLyr(_pal) ? sylls(_pal) : swP.map(sw2name),         'Pallavi — Sahityamu'),
    m(swAp,    swAp.map(sw2name),                                      'Anupallavi — Swaras'),
    m(swAp,    hasLyr(_anu) ? sylls(_anu) : swAp.map(sw2name),        'Anupallavi — Sahityamu'),
    m(swCh,    swCh.map(sw2name),                                      'Charanam — Swaras'),
    m(swCh,    hasLyr(_cha) ? sylls(_cha) : swCh.map(sw2name),        'Charanam — Sahityamu'),
  ].join('');

  const lyrSrc = xcrip ? 'faster-whisper-transcription' : 'awaiting-transcription';
  const noteSrc = _realNotes ? 'audio-pitch-detection' : 'scale-reference';

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
    '"http://www.musicxml.org/dtds/partwise.dtd">' +
    '<score-partwise version="4.0">' +
    '<work><work-title>' + _xmlEsc(title) + '</work-title></work>' +
    '<identification>' +
    '<creator type="composer">GoMaa Raga Vidya AI</creator>' +
    '<encoding><software>GoMaa Raga Vidya v4</software>' +
    '<encoding-date>' + new Date().toISOString().slice(0,10) + '</encoding-date></encoding>' +
    '<miscellaneous>' +
    '<miscellaneous-field name="raga">' + _xmlEsc(ragaInfo.label||'') + '</miscellaneous-field>' +
    '<miscellaneous-field name="melakarta">' + (ragaInfo.ragaNumber||'') + '</miscellaneous-field>' +
    '<miscellaneous-field name="arohanam">' + _xmlEsc(ragaInfo.aroha||'') + '</miscellaneous-field>' +
    '<miscellaneous-field name="avarohanam">' + _xmlEsc(ragaInfo.avaroha||'') + '</miscellaneous-field>' +
    '<miscellaneous-field name="tala">' + _xmlEsc(tala) + '</miscellaneous-field>' +
    '<miscellaneous-field name="mood">' + _xmlEsc(ragaInfo.mood||'') + '</miscellaneous-field>' +
    '<miscellaneous-field name="gamakas">' + _xmlEsc((ragaInfo.gamakas||[]).join(', ')) + '</miscellaneous-field>' +
    '<miscellaneous-field name="lyrics-source">' + lyrSrc + '</miscellaneous-field>' +
    '<miscellaneous-field name="notes-source">' + noteSrc + '</miscellaneous-field>' +
    '</miscellaneous></identification>' +
    '<part-list><score-part id="P1"><part-name>Melody</part-name>' +
    '<midi-instrument id="P1-I1"><midi-channel>1</midi-channel>' +
    '<midi-program>25</midi-program></midi-instrument></score-part></part-list>' +
    '<part id="P1">' + measures + '</part></score-partwise>';
}

function generateMidi(ragaInfo,compOpts){compOpts=compOpts||{};const tempo=Math.round(60000000/(compOpts.tempo||80));const tpb=480;const instruments=compOpts.instruments||['veena','mridangam'];const aroha=_parseSwaras(ragaInfo.aroha||'S R G M P D N S');const avaroha=_parseSwaras(ragaInfo.avaroha||'S N D P M G R S');const demo=RAGA_DEMO_LYRICS[ragaInfo.label]||{};const sec=compOpts.sections||{};const swP=_parseSwaras(demo.swaras_pallavi||ragaInfo.aroha);const swAp=_parseSwaras(demo.swaras_anupallavi||ragaInfo.avaroha);const swCh=_parseSwaras(demo.swaras_charanam||ragaInfo.aroha);const allSwaras=[...aroha,...avaroha,...swP,...swAp,...swCh];function u32(n){return[(n>>24)&0xff,(n>>16)&0xff,(n>>8)&0xff,n&0xff];}function u16(n){return[(n>>8)&0xff,n&0xff];}function varLen(n){if(n<128)return[n];const b=[];let v=n;while(v>0){b.unshift(v&0x7f);v>>=7;}for(let i=0;i<b.length-1;i++)b[i]|=0x80;return b;}function mkTrack(ev){return[0x4d,0x54,0x72,0x6b,...u32(ev.length),...ev];}const t0=[0x00,0xff,0x51,0x03,(tempo>>16)&0xff,(tempo>>8)&0xff,tempo&0xff,0x00,0xff,0x58,0x04,0x04,0x02,0x18,0x08,0x00,0xff,0x2f,0x00];const melProg=MIDI_PROG[instruments[0]]!=null?MIDI_PROG[instruments[0]]:24;const t1=[];t1.push(0x00,0xc0,melProg&0x7f);allSwaras.forEach(sw=>{const m=_swaraToMidi(sw,4);t1.push(...varLen(0),0x90,m&0x7f,80,...varLen(tpb),0x80,m&0x7f,0);});t1.push(0x00,0xff,0x2f,0x00);const t2=[];t2.push(0x00,0xc1,23);for(let i=0;i<Math.ceil(allSwaras.length/2);i++){const d=tpb*4;t2.push(...varLen(0),0x91,60,50,...varLen(0),0x91,67,45,...varLen(d),0x81,60,0,...varLen(0),0x81,67,0);}t2.push(0x00,0xff,0x2f,0x00);const t3=[];t3.push(0x00,0xc9,117&0x7f);const PAT=[38,36,42,38,36,42,38,36];for(let b=0;b<Math.ceil(allSwaras.length/8);b++){PAT.forEach(n=>{t3.push(...varLen(0),0x99,n,70,...varLen(tpb/2),0x89,n,0);});}t3.push(0x00,0xff,0x2f,0x00);const tracks=[mkTrack(t0),mkTrack(t1),mkTrack(t2),...(instruments.some(i=>['mridangam','tabla','kanjira'].includes(i))?[mkTrack(t3)]:[])] ;const hdr=[0x4d,0x54,0x68,0x64,...u32(6),...u16(1),...u16(tracks.length),...u16(tpb)];return Buffer.from([...hdr,...tracks.flat()]).toString('base64');}
module.exports={generateSheetMusicXml,generateMidi,RAGA_DEMO_LYRICS,SWARA_DISPLAY};
