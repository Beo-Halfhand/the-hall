// Where the painted originals are, and how they become sprites. Where things sit on screen is in
// public/js/hall-config.js. Crops are fractions of the image: [x, y, width, height].

import { homedir } from 'node:os';
import { join } from 'node:path';

const ATTACHMENTS = (process.env.ART_ORIGINALS ?? 'art-source/originals');
const IMAGES = join(ATTACHMENTS, 'Images');

export const SOURCES = {
  characters: {
    halfhand: join(IMAGES, 'Halfhand.jpeg'),
    tally: join(IMAGES, 'Tally.jpeg'), // the house bot
    brannock: join(IMAGES, 'Brannock.jpeg'),
    oldwick: join(ATTACHMENTS, 'Oldwick.jpeg'),
    adventurer: join(IMAGES, 'Adventurer.jpeg'),
    dwarf: join(IMAGES, 'Dwarf.jpg'),
    ranger: join(IMAGES, 'Ranger.jpeg'),
    pirate: join(IMAGES, 'Pirate.jpeg'),
    clockwork: join(IMAGES, 'Clockwork.jpeg'), // the doorman; players who already have this look keep the seat sprite
    mage: join(IMAGES, 'Mage.jpeg'),
    halfling: join(IMAGES, 'Halfling.jpeg'),
    rogue: join(IMAGES, 'Rogue.jpeg'),
    knight: join(IMAGES, 'Knight.jpeg'),
  },
  rooms: {
    v1: join(IMAGES, 'Hall_V1.jpeg'),
    v2: join(IMAGES, 'Hall_V2.jpeg'),
  },
  table: join(IMAGES, 'Table_V1.jpeg'),
  pot: join(IMAGES, 'Pot.jpeg'), // three piles, small to large, left to right
  drop: join(IMAGES, 'sealed-hand'), // a room.png or table.png here replaces the active room or the table
};

export const CONFIG = {
  // Distance from the corner colour: under `hard` is background everywhere; up to `soft` fades, if joined to the edge.
  key: { hard: 34, soft: 78, spillRadius: 6 },
  // Tally's visor is nearly the colour of the backdrop behind it, so this cut stays much closer to that colour.
  keys: { tally: { hard: 15, soft: 34, spillRadius: 2 } },

  seatPixel: 7.5, // source pixels per art pixel on a 1152-wide original; smaller originals scale to match
  doorman: 'clockwork', // whose art stands at the door and speaks in the dialogue
  doormanPixel: 13,
  portraitCrop: [0.26, 0.03, 0.52, 0.3], // The doorman's head and shoulders; made square
  portraitSize: 72,

  roomWidth: 576,
  tableWidth: 576,
  tableCrop: [0, 0.078, 1, 0.6], // window, lanterns, chairs and the felt's edge
  sideCrop: [0.62, 0.34, 0.2, 0.08], // bare stone wall, for the fill beside the room
  sideKeep: 0.42, // how much light to leave in that stone

  potPixel: 6, // source pixels per art pixel on a 1152-wide original

  colours: 96,
};
