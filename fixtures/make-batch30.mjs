#!/usr/bin/env node
// The 30 recordings of the 30-video end-to-end run (app/e2e/flows/batch30.mjs).
//
//   node fixtures/make-batch30.mjs              writes the specs to fixtures/specs/batch30/*.json
//   node fixtures/make-batch30.mjs --generate   also builds them into fixtures/out/batch30/<id>/
//                                               (generate.mjs --specs, a few at a time; needs
//                                               ffmpeg and espeak-ng). Add --jobs <n> (default 3).
//
// The specs are procedural from a fixed seed, so they come out the same every time: scripts
// from the topics below, split into 1 to 6 clips, with retakes (in the same clip and across
// clips), false starts, dead air, fillers and off-script chatter, B-roll for some, a few long
// ones. They live in their own folder, apart from fixtures/specs/*.json, so the analyzer's
// score and every other test keep reading exactly the fixtures they read before; and the
// output goes under fixtures/out/batch30/, which has no manifest.json of its own, so the
// scorer (which reads fixtures/out/<id>/manifest.json) does not pick it up.
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = join(here, 'specs', 'batch30');
const OUT_DIR = join(here, 'out', 'batch30');
const args = process.argv.slice(2);
const jobs = Number(args.includes('--jobs') ? args[args.indexOf('--jobs') + 1] : 3);

/** mulberry32: small, seeded, the same on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each topic: a title and the lines a creator means to say, in order. `long` ones are 45 to 90 s.
const TOPICS = [
  { title: 'Coffee hack', lines: ['This coffee trick changed my mornings.', 'Put a pinch of salt in the grounds.', 'It takes the bitter edge right off.', 'Try it tomorrow and tell me.'] },
  { title: 'Desk under fifty', lines: ['My whole desk setup cost under fifty dollars.', 'The lamp was twelve dollars at a thrift store.', 'The shelf is two planks and four brackets.', 'And the plant was free from my neighbour.', 'Links to everything are in my bio.'] },
  { title: 'Budget rules', lines: ['Three money rules I wish I knew at twenty.', 'One, pay yourself first, every single month.', 'Two, never buy anything the same day you see it.', 'Three, keep one month of rent in cash.', 'Save this for later.'] },
  { title: 'Plant care', lines: ['Your plants are dying for one simple reason.', 'You water them on a schedule.', 'Push a finger into the soil instead.', 'If it is dry to the knuckle, water it.', 'If not, leave it alone.'] },
  { title: 'Running shoes', lines: ['I ran two hundred miles in these shoes.', 'The cushion is still soft at the heel.', 'The grip is fine on wet roads.', 'The only problem is the narrow toe box.', 'Seven out of ten from me.'] },
  { title: 'Five minute pasta', lines: ['Dinner in five minutes, no excuses.', 'Boil thin noodles for three minutes.', 'Toss them with butter, garlic and lemon.', 'Grate a lot of cheese on top.', 'That is it, go eat.'] },
  { title: 'Phone camera tips', lines: ['Your phone camera can do so much more.', 'Wipe the lens before every shot.', 'Tap to focus, then slide down to darken.', 'Turn on the grid and keep the horizon straight.', 'Follow for part two.'] },
  { title: 'Carry-on packing', lines: ['A whole week in one carry-on bag.', 'Roll your clothes instead of folding them.', 'Wear the heavy shoes on the plane.', 'Put socks inside the other shoes.', 'Pack one outfit less than you think.'] },
  { title: 'Night skincare', lines: ['My night routine takes four minutes.', 'Cleanser first, for about a minute.', 'Then a thin layer of serum.', 'Then moisturiser, a pea sized amount.', 'Skip the fancy stuff until this is a habit.'] },
  { title: 'Study tips', lines: ['How I study for six hours without burning out.', 'Fifty minutes on, ten minutes off.', 'Phone in another room, not on silent.', 'Write the goal for each block on paper.', 'Stop before you are tired, not after.'] },
  { title: 'Home workout', lines: ['No gym, no equipment, twenty minutes.', 'Squats for one minute.', 'Push ups for one minute.', 'Lunges for one minute.', 'Rest a minute and repeat four times.'] },
  { title: 'Thrift haul', lines: ['Everything I am wearing cost eighteen dollars.', 'The jacket was six dollars.', 'The jeans were eight.', 'The shirt was four, and it still had the tags.', 'Go early on weekday mornings.'] },
  { title: 'Meal prep Sunday', lines: ['One hour on Sunday, lunch for the whole week.', 'Rice in the cooker, chicken in the oven.', 'Chop the vegetables while both cook.', 'Split it into five boxes.', 'It saves me about sixty dollars a week.'] },
  { title: 'Dog training', lines: ['Teach your dog to stay in three days.', 'Start with one second and a treat.', 'Add one second each time.', 'Step back only when the wait is solid.', 'Short sessions, every day.'] },
  { title: 'Water bottle', lines: ['This bottle keeps ice for two whole days.', 'I left it in a hot car to test it.', 'Still ice the next evening.', 'It is twenty four dollars right now.', 'Tap the orange cart below.'] },
  { title: 'Book picks', lines: ['Three books that actually changed how I think.', 'The first one is about habits.', 'The second is about money and patience.', 'The third is a novel, and it made me cry.', 'Tell me yours in the comments.'] },
  { title: 'Kitchen reset', lines: ['A clean kitchen in ten minutes flat.', 'Dishes in the machine first.', 'Wipe the counters from back to front.', 'Sweep the crumbs straight into the bin.', 'Set a timer and race it.'] },
  { title: 'Notes app review', lines: ['I tried every notes app so you do not have to.', 'This one opens in under a second.', 'It syncs without an account.', 'The search finds words inside photos.', 'It is free, link in bio.'] },
  { title: 'Bike commute', lines: ['I bike to work every day, even in winter.', 'Lights on, front and back, always.', 'Waterproof gloves matter more than the jacket.', 'Leave five minutes earlier than you need.', 'You will arrive happier.'] },
  { title: 'Hair tie trick', lines: ['The hair tie trick nobody shows you.', 'Loop it twice around the bun.', 'Pull the last loop over the top.', 'It holds all day without a headache.'] },
  { title: 'Headphones unboxing', lines: ['Unboxing the headphones everyone keeps asking about.', 'The case is tiny, smaller than my palm.', 'They pair the moment you open the lid.', 'The noise cancelling is honestly scary good.', 'Full review on Friday.'] },
  { title: 'Grocery savings', lines: ['I cut my grocery bill in half.', 'Shop with a list and never hungry.', 'Buy store brands for the basics.', 'Plan meals around what is on sale.', 'Freeze bread before it goes stale.'] },
  { title: 'Sleep routine', lines: ['I fall asleep in ten minutes now.', 'Same bedtime, even on weekends.', 'No screens for the last half hour.', 'The room is cold and completely dark.', 'Give it two weeks.'] },
  { title: 'Sneaker cleaning', lines: ['White sneakers, good as new, for one dollar.', 'Baking soda and a little dish soap.', 'Scrub with an old toothbrush.', 'Wipe them and let them dry in the shade.'] },
  { title: 'First apartment', lines: ['Things nobody tells you about your first apartment.', 'Take photos of every wall before you move in.', 'Buy a plunger before you need one.', 'Learn where the water shut off is.', 'Renter insurance is cheaper than you think.'] },
  {
    title: 'Standing desk review',
    long: true,
    lines: [
      'I used a standing desk every day for six months, here is my honest review.',
      'First, the setup took about forty minutes on my own.',
      'The instructions were clear, and every screw was labelled.',
      'The motor is quiet, quieter than my laptop fan.',
      'It goes from sitting to standing in about twelve seconds.',
      'There are four memory buttons, and I use two of them.',
      'The top is solid wood, and it has not scratched yet.',
      'Now the problems.',
      'At full height there is a little wobble when I type hard.',
      'The cable tray is too small for a real setup.',
      'And the anti collision sensor stops for no reason sometimes.',
      'Did it help my back?',
      'Yes, but only once I started switching every hour.',
      'Standing all day hurt more than sitting all day.',
      'Would I buy it again? Yes, at this price.',
      'It is four hundred dollars, and it goes on sale often.',
      'Questions in the comments, I answer all of them.',
    ],
  },
  {
    title: 'Small business week',
    long: true,
    lines: [
      'A week of running my candle business from a spare room.',
      'Monday is pouring day, forty candles in one go.',
      'The wax has to cool slowly or the tops crack.',
      'Tuesday I take the photos by the window, before noon.',
      'Wednesday is packing orders, and it always takes longer than planned.',
      'Every box gets a handwritten note.',
      'Thursday I answer messages and post three videos.',
      'Friday is the post office run.',
      'This week we shipped eighty two orders.',
      'That is our best week since we started.',
      'The hardest part is still saying no to custom requests.',
      'If you have a small business, tell me what yours is.',
      'I read every comment.',
    ],
  },
  {
    title: 'Sourdough for beginners',
    long: true,
    lines: [
      'Sourdough for complete beginners, start to finish.',
      'You need flour, water, salt and an active starter.',
      'Feed the starter the night before.',
      'In the morning it should be bubbly and doubled.',
      'Mix five hundred grams of flour with three hundred and fifty of water.',
      'Let it rest for an hour, this is called the autolyse.',
      'Add one hundred grams of starter and ten grams of salt.',
      'Squeeze it through your fingers until it comes together.',
      'Every half hour, stretch and fold it four times.',
      'Do that four times, then leave it alone.',
      'When it has grown by half, shape it into a ball.',
      'Put it in the fridge overnight.',
      'Bake it in a hot pot, lid on for twenty minutes.',
      'Then lid off for another twenty five.',
      'Wait an hour before cutting it, I know it is hard.',
      'Save this so you have it on baking day.',
    ],
  },
  { title: 'Lip balm', lines: ['This lip balm sold out three times this year.', 'It is not sticky and it does not smell.', 'One tube lasted me four months.', 'Right now it is eight dollars for two.', 'Grab it from the shop link.'] },
  { title: 'Weekend trip', lines: ['A perfect weekend in the mountains for under two hundred dollars.', 'We took the early train on Saturday.', 'The cabin was sixty dollars a night.', 'Sunday was a long hike and a lake swim.', 'Home by nine on Sunday night.', 'Full itinerary in my highlights.'] },
];

const FILLERS = ['um', 'uh', 'um', 'uh', 'er'];
const CHATTER = ['hold on', 'was that okay?', 'let me do that again', 'one more time', 'okay wait'];
const SLIPS = [', wait, no', ', sorry', ', no, again', ''];
const COLORS = ['0x355C7D', '0x6C5B7B', '0x7D3535', '0x2F6B4F', '0x8A6A2F', '0x3D5A80'];

/** Words of `line` cut short, as a false start: "Three money rules, no". */
function falseStart(line, r) {
  const words = line.replace(/[.,?!]/g, '').split(/\s+/);
  const n = Math.max(2, Math.min(words.length - 2, 2 + Math.floor(r() * 3)));
  return words.slice(0, n).join(' ') + SLIPS[Math.floor(r() * SLIPS.length)];
}

/** A flubbed take of `line` that gets redone: a slip at the end, or the same words said again. */
function retakeOf(line, r) {
  if (r() < 0.5) return line;
  const words = line.replace(/[.?!]$/, '').split(/\s+/);
  const keep = Math.max(3, words.length - 1 - Math.floor(r() * 2));
  return `${words.slice(0, keep).join(' ')}, wait, that came out wrong`;
}

const round1 = (x) => Math.round(x * 10) / 10;

function makeSpec(index, topic) {
  const r = rng(1000 + index * 7919);
  const id = `b${String(index + 1).padStart(2, '0')}`;
  // The script, as groups of units: each group is one line with whatever went wrong before it.
  const groups = topic.lines.map((line, i) => {
    const units = [];
    const g = `g${i}`;
    const roll = r();
    // Long recordings need room to breathe: more dead air and fillers, fewer retakes per line.
    const pRetake = topic.long ? 0.14 : 0.2;
    const pFalse = topic.long ? 0.12 : 0.16;
    let bad = null;
    if (roll < pRetake) bad = { say: retakeOf(line, r), keep: false, reason: 'retake', group: g };
    else if (roll < pRetake + pFalse) bad = { say: falseStart(line, r), keep: false, reason: 'false_start', group: g };
    if (r() < 0.22) units.push({ filler: FILLERS[Math.floor(r() * FILLERS.length)] });
    if (bad) units.push(bad, { pause: round1(0.6 + r() * 1.0) });
    units.push({ say: line, group: g });
    if (r() < 0.12 && i > 0) units.push({ filler: FILLERS[Math.floor(r() * FILLERS.length)] });
    if (r() < 0.45) units.push({ pause: round1(0.9 + r() * (topic.long ? 2.4 : 1.8)) });
    return { units, bad };
  });
  // A few videos open with chatter before the first line, or end with it.
  if (r() < 0.2) groups[0].units.unshift({ say: CHATTER[Math.floor(r() * CHATTER.length)], keep: false, reason: 'off_script' }, { pause: round1(0.8 + r() * 0.8) });
  if (r() < 0.25) groups.at(-1).units.push({ pause: round1(1.0 + r()) }, { say: CHATTER[Math.floor(r() * CHATTER.length)], keep: false, reason: 'off_script' });

  // Clips: 1 to 6 (a fixed spread over the 30 so every count appears several times), split at line
  // boundaries. Sometimes a flubbed take ends one clip and the redo starts the next, as when a
  // creator stops recording after a mistake.
  const clipCounts = [1, 2, 1, 3, 1, 4, 2, 1, 5, 2, 1, 3, 6, 1, 2, 1, 4, 2, 1, 3, 1, 2, 5, 1, 2, 3, 2, 4, 1, 6];
  const nClips = Math.min(clipCounts[index], groups.length);
  const cuts = new Set();
  while (cuts.size < nClips - 1) cuts.add(1 + Math.floor(r() * (groups.length - 1)));
  const boundaries = [...cuts].sort((a, b) => a - b);
  const landscape = index % 9 === 4;
  const fps = index % 5 === 2 ? 30 : index % 7 === 3 ? 30 : 60;
  const clips = [];
  let start = 0;
  for (const end of [...boundaries, groups.length]) {
    const units = groups.slice(start, end).flatMap((x) => x.units);
    clips.push({ units });
    start = end;
  }
  // Move a retake across a clip boundary: the bad take closes the previous clip.
  for (let k = 1; k < clips.length; k++) {
    const first = clips[k].units;
    const at = first.findIndex((u) => u.reason === 'retake' || u.reason === 'false_start');
    if (at >= 0 && at <= 1 && r() < 0.7) {
      const moved = first.splice(0, at + 1);
      if (first[0]?.pause !== undefined) first.shift();
      clips[k - 1].units.push({ pause: round1(0.5 + r() * 0.8) }, ...moved.filter((u) => u.pause === undefined));
    }
  }
  const spec = {
    id,
    title: topic.title,
    clips: clips.map((c, k) => ({
      name: `${id}_take${k + 1}`,
      fps: index === 12 && k === 1 ? 30 : fps,
      size: landscape ? '1280x720' : index % 11 === 7 ? '1080x1920' : '720x1280',
      leadIn: round1(0.3 + r() * 0.6),
      tail: round1(0.4 + r() * 0.8),
      units: c.units.map((u) => (u.pause !== undefined ? { pause: u.pause } : u)),
    })),
  };
  // B-roll for about a third of them: photos and short videos, named after the video.
  if ([1, 4, 7, 11, 14, 17, 20, 25, 28].includes(index)) {
    const n = 1 + (index % 3);
    spec.broll = Array.from({ length: n }, (_, k) =>
      k % 2 === 0
        ? { file: `${id}_photo${k + 1}.jpg`, kind: 'image', label: `${topic.title} photo ${k + 1}`, color: COLORS[(index + k) % COLORS.length], ...(k === 2 ? { size: '1600x1200' } : {}) }
        : { file: `${id}_shot${k + 1}.mp4`, kind: 'video', label: `${topic.title} shot ${k + 1}`, durationSec: 3 + (index % 3) },
    );
  }
  return spec;
}

if (TOPICS.length !== 30) throw new Error(`expected 30 topics, have ${TOPICS.length}`);
rmSync(SPEC_DIR, { recursive: true, force: true });
mkdirSync(SPEC_DIR, { recursive: true });
const specs = TOPICS.map((t, i) => makeSpec(i, t));
for (const s of specs) writeFileSync(join(SPEC_DIR, `${s.id}.json`), JSON.stringify(s, null, 2) + '\n');
console.log(`wrote ${specs.length} specs to ${SPEC_DIR}`);

if (args.includes('--generate')) {
  mkdirSync(OUT_DIR, { recursive: true });
  const ids = specs.map((s) => s.id);
  // Only this folder's own outputs are replaced; anything else in it (none expected) is left alone.
  for (const name of readdirSync(OUT_DIR)) if (!ids.includes(name)) console.warn(`  leaving ${join(OUT_DIR, name)} as it is`);
  const queue = [...ids];
  const t0 = Date.now();
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      await new Promise((res, rej) =>
        execFile('node', [join(here, 'generate.mjs'), '--specs', SPEC_DIR, '--out', OUT_DIR, '--only', id], { maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
          err ? rej(new Error(`${id}: ${stderr || err.message}`)) : (process.stdout.write(stdout), res()),
        ),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  console.log(`generated ${ids.length} recordings into ${OUT_DIR} in ${Math.round((Date.now() - t0) / 1000)}s`);
}
