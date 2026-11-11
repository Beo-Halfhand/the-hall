// Everything adjustable about where the art goes. Coordinates are in art pixels on the 576-wide room and table
// images in public/art/hall/. Add ?art-debug=1 to the room's address to see the hotspots outlined.

export const ART = {
  // Which room image to use: 'v1' (Hall_V1, wood) or 'v2' (Hall_V2, stone floor). Both are built.
  room: 'v1',

  // Pot sizes: the small pile below `medium` chips, the large one from `large` up.
  pot: { medium: 20, large: 60 },

  // The back of every sealed card: 'midnight' (the official symbol) or 'seal' (the wax hand).
  cardBack: 'midnight',

  // Official Midnight marks, laid over the art. The files in public/brand/midnight/ are unaltered.
  // `marks` are the small symbols in each room below: quiet silver-violet (--mark-tint in inn.css), each at a place you can go, and
  // brighter while that place is hovered or focused.
  midnight: { marks: true, rug: true, rugOpacity: 0.11 },

  rooms: {
    v1: {
      // [x, y, width, height]. Keys are game ids from the registry, plus the cage.
      hotspots: {
        'sealed-hand': [118, 479, 179, 150], // the card table, under the lantern
        'cup-and-claim': [222, 150, 150, 170], // the staircase: the dice table is upstairs. Its sign wraps, so it clears Axe Lane's on a phone
        'axe-lane': [416, 220, 118, 86], // the targets, right of the stairs
        roulette: [302, 617, 193, 141], // bottom centre
        cage: [0, 322, 252, 141], // the bar
      },
      doorman: [128, 688],
      lights: [[207, 467, 70, 0.34], [487, 581, 90, 0.3]], // [x, y, radius, strength]: the lantern and the fire
      // [centre x, centre y, size, opacity, the game or place it belongs to]: two, small and quiet, as if they'd always been there. Each
      // marks a way in (11-08 pass #26): the shield by the door at the top of the stairs is the way up to Cup & Claim; the carving in the bar's end panel is the cage.
      marks: [
        [472, 92, 15, 0.34, 'cup-and-claim'],
        [37, 421, 13, 0.3, 'cage'],
      ],
      rug: [207, 590, 290], // [centre x, centre y, size]: the floor around the card table
      furniture: [207, 548, 108, 92], // [centre x, centre y, across, down]: stays in front of the rug, so the table stands on it
    },
    v2: {
      hotspots: {
        'sealed-hand': [192, 385, 181, 145],
        'cup-and-claim': [236, 150, 110, 160], // the staircase
        'axe-lane': [346, 200, 94, 86],
        roulette: [365, 526, 177, 141],
        cage: [0, 267, 224, 145],
      },
      doorman: [250, 690],
      lights: [[284, 346, 70, 0.34], [503, 354, 90, 0.3]],
      marks: [
        [190, 133, 12, 0.34, 'cup-and-claim'], // on the purple banner by the stairs
        [39, 377, 13, 0.3, 'cage'], // carved in the end panel of the bar
      ],
      rug: [284, 490, 290],
      furniture: [284, 452, 108, 92],
    },
  },

  // The table page, on public/art/hall/table.png.
  scene: {
    frontTop: 458, // the top of the felt rail: seated characters go behind everything below this
    seats: [61, 217, 365, 515], // the centre of each of the four chairs
    backsTop: 468, // where the small sealed cards sit on the felt
    lights: [[67, 113, 70, 0.3], [515, 113, 70, 0.3]], // the two wall lanterns
  },
};
