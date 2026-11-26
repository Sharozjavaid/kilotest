/**
 * Ground truth of the `routine` test recording (fixtures/out/routine/manifest.json and
 * clip1.words.json), copied here because fixtures/out is not committed. The mock proxy
 * at assets/mock/proxy.mp4 is that recording scaled to 540x960, so these times match it.
 * Generated once by hand from the fixture; regenerate if the fixture changes.
 */
export const FIXTURE = {
  "title": "Morning routine",
  "durationSec": 21.094,
  "fps": 60,
  "width": 720,
  "height": 1280
} as const;

export interface FixtureUnit {
  start: number;
  end: number;
  keep: boolean;
  reason: "speech" | "dead_air" | "false_start" | "retake" | "filler" | "off_script";
  text: string;
}

export const FIXTURE_UNITS: FixtureUnit[] = [
  {"start":0.4,"end":1.492,"keep":false,"reason":"false_start","text":"Okay so I've been"},
  {"start":1.632,"end":1.889,"keep":false,"reason":"filler","text":"uh"},
  {"start":2.029,"end":2.757,"keep":false,"reason":"off_script","text":"hold on"},
  {"start":2.757,"end":4.157,"keep":false,"reason":"dead_air","text":""},
  {"start":4.157,"end":7.216,"keep":true,"reason":"speech","text":"Okay, I've used this every morning for two weeks."},
  {"start":7.216,"end":9.016,"keep":false,"reason":"dead_air","text":""},
  {"start":9.016,"end":11.162,"keep":true,"reason":"speech","text":"Here's what nobody tells you about it."},
  {"start":11.162,"end":12.062,"keep":false,"reason":"dead_air","text":""},
  {"start":12.062,"end":13.249,"keep":false,"reason":"false_start","text":"It's, it's really"},
  {"start":13.389,"end":13.744,"keep":false,"reason":"filler","text":"um"},
  {"start":13.744,"end":14.844,"keep":false,"reason":"dead_air","text":""},
  {"start":14.844,"end":17.783,"keep":true,"reason":"speech","text":"It takes ten seconds and it actually works."},
  {"start":17.923,"end":18.278,"keep":false,"reason":"filler","text":"um"},
  {"start":18.418,"end":20.594,"keep":true,"reason":"speech","text":"Link's below if you want to try it."},
];

/** [text, start, end, filler] */
export const FIXTURE_WORDS: Array<[string, number, number, 0 | 1]> = [
  ["Okay",0.4,0.712,0],
  ["so",0.712,0.868,0],
  ["I've",0.868,1.18,0],
  ["been",1.18,1.492,0],
  ["uh",1.632,1.889,1],
  ["hold",2.029,2.514,0],
  ["on",2.514,2.757,0],
  ["Okay,",4.157,4.53,0],
  ["I've",4.53,4.828,0],
  ["used",4.828,5.127,0],
  ["this",5.127,5.425,0],
  ["every",5.425,5.798,0],
  ["morning",5.798,6.321,0],
  ["for",6.321,6.545,0],
  ["two",6.545,6.768,0],
  ["weeks.",6.768,7.216,0],
  ["Here's",9.016,9.419,0],
  ["what",9.419,9.687,0],
  ["nobody",9.687,10.089,0],
  ["tells",10.089,10.424,0],
  ["you",10.424,10.626,0],
  ["about",10.626,10.961,0],
  ["it.",10.961,11.162,0],
  ["It's,",12.062,12.458,0],
  ["it's",12.458,12.774,0],
  ["really",12.774,13.249,0],
  ["um",13.389,13.744,1],
  ["It",14.844,15.007,0],
  ["takes",15.007,15.416,0],
  ["ten",15.416,15.661,0],
  ["seconds",15.661,16.232,0],
  ["and",16.232,16.477,0],
  ["it",16.477,16.64,0],
  ["actually",16.64,17.294,0],
  ["works.",17.294,17.783,0],
  ["um",17.923,18.278,1],
  ["Link's",18.418,18.884,0],
  ["below",18.884,19.273,0],
  ["if",19.273,19.428,0],
  ["you",19.428,19.661,0],
  ["want",19.661,19.972,0],
  ["to",19.972,20.128,0],
  ["try",20.128,20.361,0],
  ["it.",20.361,20.594,0],
];
