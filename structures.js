// Agmora - Structure Registry
// This file initialises the global registry.
// Each structure lives in its own file inside the structures/ folder.
// Add a new structure by:
//   1. Creating  structures/my_structure.js  that sets window.STRUCTURES.my_structure = { ... }
//   2. Adding    <script src="structures/my_structure.js"></script>  in index.html (before game.js)
//
// Block IDs quick reference:
//   0=Air  1=Dirt  2=Grass  3=Stone  4=Sand  5=Water  6=Wood  7=Bricks
//   8=Ruby  9=Clay  10=Snow  11=Leafs  12=Sapphire  13=Plank  24=Coal
//   25=Torch  26=Chest  29=Magic Candle  33=Grim Stone  34=Lava  40=TNT  42=Cauldron
//
// Op formats (used in cathedral_2.js and future op-based structures):
//   ["fill",  x1, y1, z1,  x2, y2, z2,  blockId]  — fill rectangular region
//   ["block", x,  y,  z,   blockId]                — place a single block
//   ["connecter", x, y, z, blockId, direction, letter] - place two touching blocks
//       blockId is clamped to 1..99; direction is "n"|"w"|"e"|"s"; letter is required "a".."z"
//       For mega-structure matching, connecter code and letter must both match.
// Coordinates are relative to the structure's anchorX/Y/Z.

window.STRUCTURES = {};
