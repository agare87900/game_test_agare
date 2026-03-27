// Agmora - Web Edition
// voxel game in WebGL using Three.js

console.log('game.js loaded');

// Debug helpers per chunk
const meshDebugHelpers = new Map();

// Fallback deterministic value-noise implementation when SimplexNoise
// from CDN is blocked (Tracking Prevention). This provides noise2D(x,y)
// returning values in approximately -1..1 so existing code continues
// to work unchanged.
if (typeof SimplexNoise === 'undefined') {
    globalThis.SimplexNoise = class SimplexNoise {
        constructor(seed = 0) {
            this.seed = seed | 0;
        }

        // Small integer hashing function producing 0..1
        _hash(i, j) {
            let n = i * 374761393 + j * 668265263 + (this.seed << 1);
            n = (n ^ (n >>> 13)) * 1274126177;
            return (n & 0x7fffffff) / 0x7fffffff;
        }

        // Smooth value noise based on bilinear interpolation; returns roughly -1..1
        noise2D(x, y) {
            const xi = Math.floor(x);
            const yi = Math.floor(y);
            const tx = x - xi;
            const ty = y - yi;

            const v00 = this._hash(xi, yi);
            const v10 = this._hash(xi + 1, yi);
            const v01 = this._hash(xi, yi + 1);
            const v11 = this._hash(xi + 1, yi + 1);

            const lerp = (a, b, t) => a + (b - a) * t;
            const nx0 = lerp(v00, v10, tx);
            const nx1 = lerp(v01, v11, tx);
            const n = lerp(nx0, nx1, ty);

            return n * 2 - 1;
        }
    };
}

class VoxelWorld {
    constructor(worldType = 'default') {
        this.worldType = worldType; // 'default' | 'flat' | 'islands' | 'fortress' | 'astral'
        this.chunks = new Map();
        this.chunkSize = 16;
        this.chunkHeight = 188;
        this.worldMinY = -60;
        this.verticalOffset = 60;
        this.worldChunkRadius = 43; // 87×87 chunk world (−43..+43 on each axis)
        this.tileSize = 1.0; // 1.0 = each voxel is 1.0 units
        this.maxLightLevel = 15; // Skylight/block-light max
        this.sunlightFactor = 1.0; // Scales skylight by time-of-day
        this.ambientMinimum = 0.45; // Fallback ambient brightness (brighter daytime)
        // Use fixed seed so all clients generate identical terrain
        this.noise = new SimplexNoise(42);
        // Slightly larger scale and lower max height to reduce mountainous terrain
        this.terrainScale = 0.06;
        this.maxHeight = 40;
        this.waterLevel = 30 + this.verticalOffset;

        // Biome noise for assigning regions: forest, desert, snowy
        this.biomeNoise = new SimplexNoise(1337);

        // Astral dimension should feel bright and airy
        if (this.worldType === 'astral') {
            this.sunlightFactor = 1.5;
            this.ambientMinimum = 0.45;
        }
    }

    getTerrainHeight(x, z) {
        // Flat world: constant baseline with 25 stone, 3 dirt, 1 grass
        if (this.worldType === 'flat') {
            return 30 + this.verticalOffset; // height produces 25 stone (height-5), 3 dirt, 1 grass
        }

        // Islands: use radial falloff to create island shapes
        if (this.worldType === 'islands') {
            const nx = x * this.terrainScale * 0.8;
            const nz = z * this.terrainScale * 0.8;
            let height = this.noise.noise2D(nx, nz) * 0.6 + 0.4; // bias up a bit

            // Apply radial falloff from world origin to create islands
            const dist = Math.hypot(x, z);
            const falloff = Math.max(0, 1 - (dist / 200));
            height = height * falloff;

            return Math.floor(height * this.maxHeight * 0.8) + 8 + this.verticalOffset;
        }

        // Astral: floating islands stay higher in the sky
        if (this.worldType === 'astral') {
            const islandNoise = this.noise.noise2D(x * 0.08, z * 0.08);
            if (islandNoise < 0.2) return 0; // no island here
            const heightNoise = this.noise.noise2D(x * 0.05 + 120, z * 0.05 - 120);
            const top = 70 + Math.floor(heightNoise * 12 + 18); // cluster around y=70-100
            return top;
        }

        // Default terrain: flat grasslands with gentle rolling
        const nx = x * this.terrainScale;
        const nz = z * this.terrainScale;
        const height = this.noise.noise2D(nx, nz) * 0.12 + 0.65; // low amplitude = flatter grasslands
        return Math.floor(height * this.maxHeight) + 15 + this.verticalOffset;
    }

    getBiome(x, z) {
        // Base noise for fine-grained biome edges
        const n = this.biomeNoise.noise2D(x * 0.015, z * 0.015); // -1..1
        // Hell Swamp occupies the top-right world corner (east + north)
        const inTopRight = x > 420 && z < -420;
        if (inTopRight) {
            // Blend corner gradients with noise so the biome edge feels organic.
            const east = Math.max(0, (x - 420) / 220);
            const north = Math.max(0, (-z - 420) / 220);
            if (n + east + north > 0.75) return 'hell_swamp';
        }
        // Eastward desert gradient: dominates east of x≈150
        const eastFactor = Math.max(0, x / 430);
        if (n + eastFactor > 0.5) return 'desert';
        // Northern snowy forest: one continuous biome beyond this latitude.
        if (z < -220) return 'snowy_forest';
        return 'forest';
    }

    getAstralLayout() {
        if (this.worldType !== 'astral') return null;

        const layout = {
            platformMinX: -10,
            platformMaxX: 10,
            platformMinZ: -10,
            platformMaxZ: 10,
            platformStoneMinY: 102,
            platformStoneMaxY: 104,
            platformDirtY: 105,
            platformGrassY: 106,
            cathedralDef: null,
            cathedralMinX: 999999,
            cathedralMaxX: -999999,
            cathedralMinZ: 999999,
            cathedralMaxZ: -999999,
            cathedralCenterX: 0,
            cathedralCenterZ: 0,
            cathedralAnchorY: 102
        };

        const sourceCathedralKey = (typeof window !== 'undefined' && window.STRUCTURES)
            ? (window.STRUCTURES.cathedral ? 'cathedral' : (window.STRUCTURES.tt ? 'tt' : null))
            : null;
        const sourceCathedral = (sourceCathedralKey && typeof window !== 'undefined' && window.STRUCTURES)
            ? window.STRUCTURES[sourceCathedralKey]
            : null;

        if (sourceCathedral && Array.isArray(sourceCathedral.ops)) {
            let minRX = 999999, maxRX = -999999;
            let minRZ = 999999, maxRZ = -999999;

            for (const op of sourceCathedral.ops) {
                if (op[0] === 'fill') {
                    const rx1 = Math.min(op[1], op[4]);
                    const rx2 = Math.max(op[1], op[4]);
                    const rz1 = Math.min(op[3], op[6]);
                    const rz2 = Math.max(op[3], op[6]);
                    minRX = Math.min(minRX, rx1);
                    maxRX = Math.max(maxRX, rx2);
                    minRZ = Math.min(minRZ, rz1);
                    maxRZ = Math.max(maxRZ, rz2);
                } else if (op[0] === 'block' || op[0] === 'connecter' || op[0] === 'connector') {
                    minRX = Math.min(minRX, op[1]);
                    maxRX = Math.max(maxRX, op[1]);
                    minRZ = Math.min(minRZ, op[3]);
                    maxRZ = Math.max(maxRZ, op[3]);
                }
            }

            if (minRX <= maxRX && minRZ <= maxRZ) {
                const platformCenterX = Math.floor((layout.platformMinX + layout.platformMaxX) / 2);
                const relCenterX = (minRX + maxRX) / 2;
                const anchorX = Math.round(platformCenterX - relCenterX);
                const desiredCatMinZ = layout.platformMaxZ + 8;
                const anchorZ = desiredCatMinZ - minRZ;

                layout.cathedralDef = {
                    ...sourceCathedral,
                    __structureKey: sourceCathedralKey,
                    anchorX,
                    anchorY: layout.platformStoneMinY,
                    anchorZ
                };

                layout.cathedralMinX = anchorX + minRX;
                layout.cathedralMaxX = anchorX + maxRX;
                layout.cathedralMinZ = anchorZ + minRZ;
                layout.cathedralMaxZ = anchorZ + maxRZ;
                layout.cathedralCenterX = (layout.cathedralMinX + layout.cathedralMaxX) / 2;
                layout.cathedralCenterZ = (layout.cathedralMinZ + layout.cathedralMaxZ) / 2;
                layout.cathedralAnchorY = layout.cathedralDef.anchorY;
            }
        }

        return layout;
    }

    getHellSwampPortalConfig() {
        // World edge is ±(worldChunkRadius * chunkSize). Keep portal safely inside the top-right corner.
        const edge = this.worldChunkRadius * this.chunkSize;
        return {
            centerX: edge - 96,
            centerZ: -(edge - 96),
            halfSize: 2, // 5x5 hole
            bottomY: 12
        };
    }

    carveHellSwampPortalInChunk(chunk, cx, cz) {
        if (this.worldType !== 'default') return;

        const cfg = this.getHellSwampPortalConfig();
        const minX = cfg.centerX - cfg.halfSize;
        const maxX = cfg.centerX + cfg.halfSize;
        const minZ = cfg.centerZ - cfg.halfSize;
        const maxZ = cfg.centerZ + cfg.halfSize;

        const chunkMinX = cx * this.chunkSize;
        const chunkMaxX = chunkMinX + this.chunkSize - 1;
        const chunkMinZ = cz * this.chunkSize;
        const chunkMaxZ = chunkMinZ + this.chunkSize - 1;

        // Fast reject if this chunk does not overlap the 5x5 portal hole footprint.
        if (chunkMaxX < minX || chunkMinX > maxX || chunkMaxZ < minZ || chunkMinZ > maxZ) return;

        for (let wx = Math.max(minX, chunkMinX); wx <= Math.min(maxX, chunkMaxX); wx++) {
            for (let wz = Math.max(minZ, chunkMinZ); wz <= Math.min(maxZ, chunkMaxZ); wz++) {
                const lx = wx - chunkMinX;
                const lz = wz - chunkMinZ;
                const topY = Math.min(this.chunkHeight - 2, this.getTerrainHeight(wx, wz) + 2);

                // Carve an open shaft from terrain surface down to just above portal floor.
                for (let y = cfg.bottomY + 1; y <= topY; y++) {
                    chunk.blocks[this.getBlockIndex(lx, y, lz)] = 0;
                }

                // Ensure solid support under the portal floor.
                for (let y = 2; y < cfg.bottomY; y++) {
                    const idx = this.getBlockIndex(lx, y, lz);
                    if (chunk.blocks[idx] === 0 || chunk.blocks[idx] === 5) chunk.blocks[idx] = 33;
                }

                // Bottom of hole is Fairia portal blocks.
                chunk.blocks[this.getBlockIndex(lx, cfg.bottomY, lz)] = 46;
            }
        }
    }

    carveCavesInChunk(chunk, cx, cz) {
        if (this.worldType !== 'default' && this.worldType !== 'islands') return;

        const chunkMinX = cx * this.chunkSize;
        const chunkMinZ = cz * this.chunkSize;

        for (let x = 0; x < this.chunkSize; x++) {
            for (let z = 0; z < this.chunkSize; z++) {
                const worldX = chunkMinX + x;
                const worldZ = chunkMinZ + z;
                const surfaceHeight = this.getTerrainHeight(worldX, worldZ);
                const caveTopY = Math.min(this.chunkHeight - 2, surfaceHeight + 1);

                // Keep bottom layers intact to avoid void holes; allow some caves to reach surface.
                for (let y = 3; y <= caveTopY; y++) {
                    const worldY = y;
                    const idx = this.getBlockIndex(x, y, z);
                    const blockType = chunk.blocks[idx];

                    // Carve stone, ore, dirt, and surface blocks to create cave openings
                    if (blockType !== 1 && blockType !== 2 && blockType !== 3 && blockType !== 4 && blockType !== 24 && blockType !== 33 && blockType !== 34) continue;

                    // Use 3D noise for cave generation
                    // Combine multiple noise layers at different scales for diversity
                    const scale1 = this.noise.noise2D(worldX * 0.04, worldZ * 0.04 + worldY * 0.08);
                    const scale2 = this.noise.noise2D(worldX * 0.08, worldZ * 0.08 - worldY * 0.06);
                    const scale3 = this.noise.noise2D(worldX * 0.12, worldZ * 0.12 + worldY * 0.04);

                    // Combine scales with weighted average
                    const caveNoise = (scale1 * 0.5 + scale2 * 0.3 + scale3 * 0.2);
                    const normalized = (caveNoise + 1) / 2; // Convert from -1..1 to 0..1

                    // Lower threshold for deeper caves, higher threshold near surface to bleed through
                    const depthFactor = Math.max(0.2, 1 - (worldY / this.chunkHeight));
                    const threshold = 0.28 + depthFactor * 0.06;

                    if (normalized < threshold) {
                        chunk.blocks[idx] = 0; // Air - carve out cave
                    }
                }
            }
        }
    }

    getChunkKey(cx, cz) {
        return `${cx},${cz}`;
    }

    getChunk(cx, cz) {
        // World boundary: reject chunks outside the 87×87 radius
        if (Math.abs(cx) > this.worldChunkRadius || Math.abs(cz) > this.worldChunkRadius) {
            // Return a shared solid-stone boundary chunk so faces at the edge render correctly
            if (!this._boundaryChunk) {
                const b = {
                    cx: 0, cz: 0,
                    blocks: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize).fill(1), // stone (ID 1)
                    skyLight: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
                    blockLight: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
                    modified: false
                };
                this._boundaryChunk = b;
            }
            return this._boundaryChunk;
        }
        const key = this.getChunkKey(cx, cz);
        if (!this.chunks.has(key)) {
            const newChunk = this.generateChunk(cx, cz);
            this.chunks.set(key, newChunk);
            // Compute initial lighting for the newly generated chunk
            this.computeLightingForChunk(cx, cz);
        }
        return this.chunks.get(key);
    }

    generateChunk(cx, cz) {
        const chunk = {
            cx, cz,
            blocks: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
            skyLight: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
            blockLight: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
            modified: true
        };

        // Fairia dimension: grim stone roof, grim stone and lava underground
        if (this.worldType === 'fairia') {
            // Grim stone roof at y = chunkHeight-1
            for (let x = 0; x < this.chunkSize; x++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    chunk.blocks[this.getBlockIndex(x, this.chunkHeight-1, z)] = 33; // Grim Stone roof
                }
            }
            // Terrain and underground
            for (let x = 0; x < this.chunkSize; x++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    const worldX = cx * this.chunkSize + x;
                    const worldZ = cz * this.chunkSize + z;
                    const height = this.getTerrainHeight(worldX, worldZ);
                    for (let y = 0; y < this.chunkHeight-1; y++) {
                        const idx = this.getBlockIndex(x, y, z);
                        if (y === this.chunkHeight-2) {
                            chunk.blocks[idx] = 33; // Grim Stone just below roof
                        } else if (y > height) {
                            chunk.blocks[idx] = 0; // Air
                        } else if (y > height - 2) {
                            chunk.blocks[idx] = 1; // Dirt
                        } else if (y > height - 5) {
                            chunk.blocks[idx] = 3; // Stone
                        } else if (y > 10) {
                            // Mix grim stone and stone
                            chunk.blocks[idx] = (this.noise.noise2D(worldX * 0.1, worldZ * 0.1 + y) > 0.2) ? 33 : 3;
                        } else {
                            // Lava pools below y=10
                            chunk.blocks[idx] = (this.noise.noise2D(worldX * 0.2, worldZ * 0.2 + y) > 0.1) ? 34 : 33;
                        }
                    }
                }
            }
            return chunk;
        }
        // Astral dimension: floating islands in the sky with air beneath
        if (this.worldType === 'astral') {
            const layout = this.getAstralLayout();
            const cathedralDef = layout ? layout.cathedralDef : null;
            const PLATFORM_MIN_X = layout ? layout.platformMinX : -10;
            const PLATFORM_MAX_X = layout ? layout.platformMaxX : 10;
            const PLATFORM_MIN_Z = layout ? layout.platformMinZ : -10;
            const PLATFORM_MAX_Z = layout ? layout.platformMaxZ : 10;
            const PLATFORM_STONE_MIN_Y = layout ? layout.platformStoneMinY : 102;
            const PLATFORM_STONE_MAX_Y = layout ? layout.platformStoneMaxY : 104;
            const PLATFORM_DIRT_Y = layout ? layout.platformDirtY : 105;
            const PLATFORM_GRASS_Y = layout ? layout.platformGrassY : 106;

            const cathedralMinX = layout ? layout.cathedralMinX : 999999;
            const cathedralMaxX = layout ? layout.cathedralMaxX : -999999;
            const cathedralMinZ = layout ? layout.cathedralMinZ : 999999;
            const cathedralMaxZ = layout ? layout.cathedralMaxZ : -999999;
            const skipPad = 2;
            const skipMinX = Math.min(PLATFORM_MIN_X, cathedralMinX) - skipPad;
            const skipMaxX = Math.max(PLATFORM_MAX_X, cathedralMaxX) + skipPad;
            const skipMinZ = Math.min(PLATFORM_MIN_Z, cathedralMinZ) - skipPad;
            const skipMaxZ = Math.max(PLATFORM_MAX_Z, cathedralMaxZ) + skipPad;

            for (let x = 0; x < this.chunkSize; x++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    // Keep a thin bedrock layer at the bottom for safety
                    chunk.blocks[this.getBlockIndex(x, 0, z)] = 3;
                    chunk.blocks[this.getBlockIndex(x, 1, z)] = 3;

                    const worldX = cx * this.chunkSize + x;
                    const worldZ = cz * this.chunkSize + z;

                    // Skip normal island generation inside reserved footprint.
                    if (worldX >= skipMinX && worldX <= skipMaxX &&
                        worldZ >= skipMinZ && worldZ <= skipMaxZ) {
                        continue;
                    }

                    const islandNoise = this.noise.noise2D(worldX * 0.04, worldZ * 0.04);
                    if (islandNoise < 0.1) continue; // Mostly empty sky

                    const heightNoise = this.noise.noise2D(worldX * 0.05 + 120, worldZ * 0.05 - 120);
                    const topY = 70 + Math.floor(heightNoise * 12 + 18); // ~70-100 range
                    const thickness = 8 + Math.floor((islandNoise + 1) * 5); // 8-18 blocks thick
                    const startY = Math.max(2, topY - thickness);
                    const endY = Math.min(this.chunkHeight - 1, topY);

                    for (let y = startY; y <= endY; y++) {
                        const idx = this.getBlockIndex(x, y, z);
                        if (y === endY) {
                            chunk.blocks[idx] = 2; // Grass on the very top
                        } else if (y >= endY - 2) {
                            chunk.blocks[idx] = 1; // Dirt near surface
                        } else {
                            chunk.blocks[idx] = 3; // Stone core
                        }
                    }
                }
            }

            // Add guaranteed land mass beneath cathedral so it never floats.
            if (cathedralDef) {
                const LAND_PAD = 3;
                const landMinX = cathedralMinX - LAND_PAD;
                const landMaxX = cathedralMaxX + LAND_PAD;
                const landMinZ = cathedralMinZ - LAND_PAD;
                const landMaxZ = cathedralMaxZ + LAND_PAD;
                const lx1 = Math.max(landMinX, cx * this.chunkSize);
                const lx2 = Math.min(landMaxX, cx * this.chunkSize + this.chunkSize - 1);
                const lz1 = Math.max(landMinZ, cz * this.chunkSize);
                const lz2 = Math.min(landMaxZ, cz * this.chunkSize + this.chunkSize - 1);

                if (lx1 <= lx2 && lz1 <= lz2) {
                    const cathedralFloorY = cathedralDef.anchorY;
                    for (let wx = lx1; wx <= lx2; wx++) {
                        for (let wz = lz1; wz <= lz2; wz++) {
                            const lx = wx - cx * this.chunkSize;
                            const lz = wz - cz * this.chunkSize;
                            // Foundation only: never overwrite cathedral floor/interior layers.
                            for (let y = cathedralFloorY - 10; y <= cathedralFloorY - 1; y++) {
                                chunk.blocks[this.getBlockIndex(lx, y, lz)] = 3;
                            }
                            // Natural cap only outside the exact cathedral footprint.
                            const inCathedralFootprint = (wx >= cathedralMinX && wx <= cathedralMaxX && wz >= cathedralMinZ && wz <= cathedralMaxZ);
                            if (!inCathedralFootprint) {
                                chunk.blocks[this.getBlockIndex(lx, cathedralFloorY, lz)] = 1;
                                chunk.blocks[this.getBlockIndex(lx, cathedralFloorY + 1, lz)] = 2;
                            }
                        }
                    }
                }
            }

            // Spawn platform: layered stone/dirt/grass, near origin.
            const px1 = Math.max(PLATFORM_MIN_X, cx * this.chunkSize);
            const px2 = Math.min(PLATFORM_MAX_X, cx * this.chunkSize + this.chunkSize - 1);
            const pz1 = Math.max(PLATFORM_MIN_Z, cz * this.chunkSize);
            const pz2 = Math.min(PLATFORM_MAX_Z, cz * this.chunkSize + this.chunkSize - 1);
            if (px1 <= px2 && pz1 <= pz2) {
                for (let wx = px1; wx <= px2; wx++) {
                    for (let wz = pz1; wz <= pz2; wz++) {
                        // Safety: do not place spawn platform tiles inside cathedral footprint.
                        if (cathedralDef && wx >= cathedralMinX && wx <= cathedralMaxX && wz >= cathedralMinZ && wz <= cathedralMaxZ) {
                            continue;
                        }
                        const lx = wx - cx * this.chunkSize;
                        const lz = wz - cz * this.chunkSize;
                        for (let y = PLATFORM_STONE_MIN_Y; y <= PLATFORM_STONE_MAX_Y; y++) {
                            chunk.blocks[this.getBlockIndex(lx, y, lz)] = 3;
                        }
                        chunk.blocks[this.getBlockIndex(lx, PLATFORM_DIRT_Y, lz)] = 1;
                        chunk.blocks[this.getBlockIndex(lx, PLATFORM_GRASS_Y, lz)] = 2;
                    }
                }
            }

            // Apply cathedral structure from structures.js
            if (cathedralDef) {
                this.applyMegaStructureToChunk(chunk, cx, cz, cathedralDef);
            }

            return chunk;
        }
        let dungeonEntryHeight = null;
        // Generate terrain
        for (let x = 0; x < this.chunkSize; x++) {
            for (let z = 0; z < this.chunkSize; z++) {
                const worldX = cx * this.chunkSize + x;
                const worldZ = cz * this.chunkSize + z;

                // Fortress mode: construct a 64x64x64 stone cube centered at origin
                if (this.worldType === 'fortress') {
                    for (let y = 0; y < this.chunkHeight; y++) {
                        const worldY = y;
                        // Cube bounds: from -32..31 in X and Z, and 0..63 in Y
                        if (worldX >= -32 && worldX < 32 && worldZ >= -32 && worldZ < 32 && worldY >= 0 && worldY < 64) {
                            // Fill with stone
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Stone
                        } else {
                            // outside fortress is air
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 0;
                        }
                    }
                    continue;
                }

                const height = this.getTerrainHeight(worldX, worldZ);
                if (worldX === 0 && worldZ === 0) dungeonEntryHeight = height;
                const biome = (this.worldType === 'default') ? this.getBiome(worldX, worldZ) : 'forest';

                for (let y = 0; y < this.chunkHeight; y++) {
                    const worldY = y;

                    // Bedrock
                    if (worldY < 2) {
                        chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Bedrock
                        continue;
                    }

                    // Solid stone deep below surface
                    if (worldY < height - 3) {
                        // Coal ore spawns randomly in stone (45% chance)
                        const oreNoise = this.noise.noise2D(worldX * 0.1 + worldY, worldZ * 0.1 + worldY);
                        const r = (oreNoise + 1) / 2; // Convert -1..1 to 0..1
                        
                        // Grim Stone appears deeper (below y=15)
                        if (worldY < 15) {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 33; // Grim Stone
                        } else if (r < 0.08) {
                            // Lava pockets underground (below y=15)
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 34; // Lava
                        } else if (r < 0.45) {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 24; // Coal
                        } else {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Stone
                        }
                        continue;
                    }

                    // Surface/sub-surface layers (vary by biome)
                    if (worldY < height) {
                        if (biome === 'desert') {
                            // Desert: mostly sand to a few layers
                            if (worldY >= height - 3) chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand
                            else chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Stone beneath
                        } else if (biome === 'hell_swamp') {
                            // Hell Swamp: grim, stony soil beneath the surface
                            if (worldY >= height - 3) chunk.blocks[this.getBlockIndex(x, y, z)] = 33; // Grim Stone
                            else chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Stone
                        } else if (biome === 'snowy_forest') {
                            // Snowy forest: dirt under snow cap
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 1; // Dirt
                        } else {
                            // Forest/others: normal dirt; shoreline handling near water
                            if ((this.worldType === 'default' || this.worldType === 'islands') && height <= this.waterLevel + 1) {
                                if (worldY >= height - 1) chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand
                                else if (worldY >= height - 4) chunk.blocks[this.getBlockIndex(x, y, z)] = 9; // Clay
                                else chunk.blocks[this.getBlockIndex(x, y, z)] = 1; // Dirt
                            } else {
                                chunk.blocks[this.getBlockIndex(x, y, z)] = 1; // Dirt
                            }
                        }
                        continue;
                    }

                    // Surface block (top) varies by biome
                    if (worldY === height) {
                        if (biome === 'desert') {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand
                        } else if (biome === 'hell_swamp') {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 33; // Grim Stone surface
                        } else if (biome === 'snowy_forest') {
                            // Snowy biome uses snow as the top surface layer
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 10; // Snow
                        } else {
                            if ((this.worldType === 'default' || this.worldType === 'islands') && height <= this.waterLevel + 1) {
                                chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand near water
                            } else {
                                chunk.blocks[this.getBlockIndex(x, y, z)] = 2; // Grass
                            }
                        }
                        continue;
                    }

                    // Water and underwater areas (leave water blocks intact)
                    if (worldY < this.waterLevel) {
                        if (biome === 'hell_swamp') {
                            // Hell Swamp pools glow with lava.
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 34; // Lava
                        } else {
                            // In snowy biomes, consider icy water (if we had an ice block). For now, keep water.
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 5; // Water
                        }
                        continue;
                    }
                }

                // Tree placement after column generated
                if ((biome === 'forest' || biome === 'snowy_forest') && height > this.waterLevel + 1) {
                    // Use seeded noise for deterministic tree placement across clients
                    const treeNoise = this.noise.noise2D(worldX * 0.3, worldZ * 0.3);
                    const r = (treeNoise + 1) / 2; // Convert -1..1 to 0..1
                    if (r < 0.08) {
                        // Snowy forest uses snow canopy; regular forest uses leaves
                        const canopyBlock = biome === 'snowy_forest' ? 10 : 11; // 10=Snow, 11=Leaves
                        const trunkHeight = 4 + Math.floor(Math.abs(this.noise.noise2D(worldX * 0.5, worldZ * 0.5)) * 2);
                        
                        // Wood trunk
                        for (let ty = 0; ty < trunkHeight; ty++) {
                            const wy = height + ty + 1;
                            if (wy < this.chunkHeight) {
                                chunk.blocks[this.getBlockIndex(x, wy, z)] = 6; // Wood
                            }
                        }
                        
                        // Canopy (2-3 blocks tall)
                        const topY = height + trunkHeight + 1;
                        const leafHeight = 2 + Math.floor(Math.abs(this.noise.noise2D(worldX * 0.7, worldZ * 0.7)) * 1.5);
                        
                        for (let ly = 0; ly < leafHeight; ly++) {
                            const canopyY = topY + ly;
                            const leafRadius = ly === leafHeight - 1 ? 1 : 2;
                            
                            for (let lx = -leafRadius; lx <= leafRadius; lx++) {
                                for (let lz = -leafRadius; lz <= leafRadius; lz++) {
                                    const dist = Math.sqrt(lx * lx + lz * lz);
                                    if (dist > leafRadius + 0.5) continue;
                                    
                                    const ax = x + lx;
                                    const az = z + lz;
                                    
                                    if (ax >= 0 && ax < this.chunkSize && az >= 0 && az < this.chunkSize && canopyY < this.chunkHeight) {
                                        if (!(lx === 0 && lz === 0 && ly === 0)) {
                                            chunk.blocks[this.getBlockIndex(ax, canopyY, az)] = canopyBlock;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Carve dungeon/maze near spawn
        this.carveDungeonInChunk(chunk, cx, cz, dungeonEntryHeight !== null ? dungeonEntryHeight : this.getTerrainHeight(0, 0));

        // Build desert pyramid (only in default world)
        this.buildPyramidInChunk(chunk, cx, cz);

        // Build overworld castle west of spawn using structures/Castle.js definition.
        this.buildCastleInChunk(chunk, cx, cz);

        // Carve the 5x5 Hell Swamp portal pit in the top-right corner biome.
        this.carveHellSwampPortalInChunk(chunk, cx, cz);

        // Carve cave systems throughout the underground
        this.carveCavesInChunk(chunk, cx, cz);

        return chunk;
    }

    carveDungeonInChunk(chunk, cx, cz, surfaceHeightAtEntry) {
        // Dungeon footprint: x,z in [-16,15], floor y=19, corridors at y=20..22, ceiling y=23, room at y=19..21
        // Parameters come from structures.js (window.STRUCTURES.dungeon) when available.
        const dungeonDef = (typeof window !== 'undefined' && window.STRUCTURES && window.STRUCTURES.dungeon)
            ? window.STRUCTURES.dungeon : null;

        const anchorX  = dungeonDef ? (dungeonDef.anchorX || 0) : 0;
        const anchorZ  = dungeonDef ? (dungeonDef.anchorZ || 0) : 0;
        const minX     = anchorX + (dungeonDef ? dungeonDef.footprintMinX : -16);
        const maxX     = anchorX + (dungeonDef ? dungeonDef.footprintMaxX :  15);
        const minZ     = anchorZ + (dungeonDef ? dungeonDef.footprintMinZ : -16);
        const maxZ     = anchorZ + (dungeonDef ? dungeonDef.footprintMaxZ :  15);
        const floorY   = dungeonDef ? dungeonDef.floorY   : 19;
        const ceilingY = dungeonDef ? dungeonDef.ceilingY : 23;
        const roomY = floorY;

        const worldYStartShaft = surfaceHeightAtEntry + 3; // start a bit above ground
        const shaftHalf = 0; // 1x1 shaft

        // Pick a random corner for the room
        const corners = [
            { x: -12, z: -12 }, // southwest
            { x: -12, z: 11 },  // northwest
            { x: 11, z: -12 },  // southeast
            { x: 11, z: 11 }    // northeast
        ];
        const noiseVal = (this.noise.noise2D(cx * 7.3, cz * 8.1) + 1) * 0.5; // map -1..1 to 0..1
        const cornerIndex = Math.floor(noiseVal * corners.length) % corners.length;
        const roomCorner = corners[cornerIndex];
        const roomCenterX = roomCorner.x;
        const roomCenterZ = roomCorner.z;

        for (let x = 0; x < this.chunkSize; x++) {
            for (let z = 0; z < this.chunkSize; z++) {
                const worldX = cx * this.chunkSize + x;
                const worldZ = cz * this.chunkSize + z;

                // Skip if outside footprint and not the shaft
                const inFootprint = worldX >= minX && worldX <= maxX && worldZ >= minZ && worldZ <= maxZ;
                const inShaft = Math.abs(worldX) <= shaftHalf && Math.abs(worldZ) <= shaftHalf;
                if (!inFootprint && !inShaft) continue;

                for (let y = 0; y < this.chunkHeight; y++) {
                    const idx = this.getBlockIndex(x, y, z);
                    const worldY = y;

                    // Entrance shaft from surface down to corridor top so it always meets the maze
                    if (inShaft && worldY <= worldYStartShaft && worldY >= floorY + 1) {
                        chunk.blocks[idx] = 0; // air
                        chunk.modified = true;
                        chunk.playerModified = true;
                        continue;
                    }

                    if (!inFootprint) continue;

                    // Stairs/walkway connecting maze to room
                    const toRoomX = worldX - roomCenterX;
                    const toRoomZ = worldZ - roomCenterZ;
                    const distToRoom = Math.sqrt(toRoomX * toRoomX + toRoomZ * toRoomZ);
                    const inStair = distToRoom >= 5 && distToRoom <= 8 && Math.abs(toRoomX) <= 1 && Math.abs(toRoomZ) <= 8;
                    if (inStair) {
                        const stairFloor = floorY; // keep stairs level to meet room floor cleanly
                        if (worldY === stairFloor) {
                            chunk.blocks[idx] = 3; // walkway/step surface
                            chunk.modified = true;
                            chunk.playerModified = true;
                            continue;
                        }
                        if (worldY > stairFloor && worldY < ceilingY) {
                            chunk.blocks[idx] = 0; // air above steps
                            chunk.modified = true;
                            chunk.playerModified = true;
                            continue;
                        }
                        // keep stone below the walkway for support
                        if (worldY < stairFloor) {
                            chunk.blocks[idx] = 3;
                            continue;
                        }
                    }

                    // Base floor and ceiling
                    if (worldY === floorY) {
                        chunk.blocks[idx] = 3; // stone floor
                        continue;
                    }
                    if (worldY === ceilingY) {
                        chunk.blocks[idx] = 3; // stone ceiling
                        continue;
                    }

                    // Room carving at random corner
                    const roomDx = worldX - roomCenterX;
                    const roomDz = worldZ - roomCenterZ;
                    const inRoom = Math.abs(roomDx) <= 4 && Math.abs(roomDz) <= 4 && worldY >= roomY && worldY <= roomY + 2;
                    if (inRoom) {
                        if (worldY === roomY) {
                            chunk.blocks[idx] = 3; // stone floor
                        } else {
                            // Place a chest at room center on floor+1
                            if (roomDx === 0 && roomDz === 0 && worldY === roomY + 1) {
                                chunk.blocks[idx] = 26; // chest block
                            } else {
                                chunk.blocks[idx] = 0; // air
                            }
                        }
                        chunk.modified = true;
                        chunk.playerModified = true;
                        continue;
                    }

                    // Maze corridors at y=20..22 (air), walls elsewhere remain stone
                    if (worldY > floorY && worldY < ceilingY) {
                        // Grid maze: 3-wide corridors on 7-block grid with noise variation
                        const gx = ((worldX % 7) + 7) % 7;
                        const gz = ((worldZ % 7) + 7) % 7;
                        const n = this.noise.noise2D(worldX * 0.25, worldZ * 0.25);
                        // Carve 3-wide corridors: center (0) and ±1 from grid lines
                        const carve = (gx <= 1 || gx >= 6) || (gz <= 1 || gz >= 6) || n > 0.35;
                        if (carve) {
                            chunk.blocks[idx] = 0; // corridor air
                            chunk.modified = true;
                            chunk.playerModified = true;

                        }
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------
    // Desert Pyramid at world center (300, ?, 300)
    // Exterior: 5-step sand pyramid (200×200 base) with 128×128 grand
    // chamber carved inside.  Underground maze below with a staircase
    // connecting the two.
    // ---------------------------------------------------------------
    buildPyramidInChunk(chunk, cx, cz) {
        // Parameters come from structures.js (window.STRUCTURES.pyramid) when available.
        const pyramidDef = (typeof window !== 'undefined' && window.STRUCTURES && window.STRUCTURES.pyramid)
            ? window.STRUCTURES.pyramid : null;

        const PX        = pyramidDef ? pyramidDef.centerX        : 300;
        const PZ        = pyramidDef ? pyramidDef.centerZ        : 300;
        const halfSize  = pyramidDef ? pyramidDef.halfSize        : 64;
        const lH        = pyramidDef ? pyramidDef.layerHeight     : 10;
        const lS        = pyramidDef ? pyramidDef.layerStep       : 16;
        const blockType = pyramidDef ? pyramidDef.blockType       : 4;
        const chamHalf  = pyramidDef ? pyramidDef.chamberHalfSize : 27;
        const mazeDepth = pyramidDef ? pyramidDef.mazeDepth       : 20;

        const PYRAMID_MIN_X = PX - halfSize;
        const PYRAMID_MAX_X = PX + halfSize - 1;
        const PYRAMID_MIN_Z = PZ - halfSize;
        const PYRAMID_MAX_Z = PZ + halfSize - 1;

        const cMinX = cx * this.chunkSize;
        const cMaxX = cMinX + this.chunkSize - 1;
        const cMinZ = cz * this.chunkSize;
        const cMaxZ = cMinZ + this.chunkSize - 1;

        // Quick-reject chunks outside the pyramid footprint
        if (cMaxX < PYRAMID_MIN_X || cMinX > PYRAMID_MAX_X) return;
        if (cMaxZ < PYRAMID_MIN_Z || cMinZ > PYRAMID_MAX_Z) return;

        const baseY = this.getTerrainHeight(PX, PZ); // surface height at center

        // Build step-pyramid layers from parameters
        const pyLayers = [];
        for (let i = 0; i < (pyramidDef ? pyramidDef.layers : 5); i++) {
            const inset  = i * lS;
            const yStart = baseY + i * lH;
            const yEnd   = baseY + (i + 1) * lH - 1;
            pyLayers.push([
                PX - halfSize + inset, PX + halfSize - 1 - inset,
                PZ - halfSize + inset, PZ + halfSize - 1 - inset,
                yStart, yEnd
            ]);
        }

        // Upper room: centered inside the pyramid (uses chamHalfSize from structures.js).
        const CHAM_MIN_X = PX - chamHalf;
        const CHAM_MAX_X = PX + chamHalf;
        const CHAM_MIN_Z = PZ - chamHalf;
        const CHAM_MAX_Z = PZ + chamHalf;
        const CHAM_BOT = baseY + 1;
        const CHAM_TOP = baseY + 8;

        // Underground maze: same footprint as pyramid base (uses halfSize & mazeDepth from structures.js).
        const MAZE_MIN_X    = PX - halfSize;
        const MAZE_MAX_X    = PX + halfSize - 1;
        const MAZE_MIN_Z    = PZ - halfSize;
        const MAZE_MAX_Z    = PZ + halfSize - 1;
        const MAZE_FLOOR_Y  = baseY - mazeDepth;        // stone floor of maze
        const MAZE_WALL_TOP = baseY - 1;                // top wall block
        const MAZE_AIR_BOT  = baseY - (mazeDepth - 1); // bottom walkable air
        const MAZE_AIR_TOP  = baseY - 2;                // top walkable air (3 tall corridor)

        for (let lx = 0; lx < this.chunkSize; lx++) {
            for (let lz = 0; lz < this.chunkSize; lz++) {
                const wx = cx * this.chunkSize + lx;
                const wz = cz * this.chunkSize + lz;
                const inPyramid = wx >= PYRAMID_MIN_X && wx <= PYRAMID_MAX_X && wz >= PYRAMID_MIN_Z && wz <= PYRAMID_MAX_Z;
                const inChamber = wx >= CHAM_MIN_X && wx <= CHAM_MAX_X && wz >= CHAM_MIN_Z && wz <= CHAM_MAX_Z;
                const inMaze = wx >= MAZE_MIN_X && wx <= MAZE_MAX_X && wz >= MAZE_MIN_Z && wz <= MAZE_MAX_Z;

                // ── 1. Pyramid exterior ──────────────────────────────
                for (const [minX, maxX, minZ, maxZ, yMin, yMax] of pyLayers) {
                    if (wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ) {
                        for (let y = yMin; y <= yMax && y < this.chunkHeight; y++) {
                            if (y < 0) continue;
                            const carveChamber = y >= CHAM_BOT && y <= CHAM_TOP && inChamber;
                            chunk.blocks[this.getBlockIndex(lx, y, lz)] = carveChamber ? 0 : blockType;
                        }
                    }
                }

                // ── 2. Flatten & sand-fill terrain under the pyramid base
                if (inPyramid) {
                    for (let y = Math.max(0, baseY - 6); y < baseY; y++) {
                        chunk.blocks[this.getBlockIndex(lx, y, lz)] = blockType; // fill under base
                    }
                }

                // ── 3. Underground maze ──────────────────────────────
                if (inMaze) {
                    // Stone floor
                    if (MAZE_FLOOR_Y >= 0 && MAZE_FLOOR_Y < this.chunkHeight) {
                        chunk.blocks[this.getBlockIndex(lx, MAZE_FLOOR_Y, lz)] = 3;
                    }
                    // Stone ceiling (connects to pyramid underside)
                    if (MAZE_WALL_TOP >= 0 && MAZE_WALL_TOP < this.chunkHeight) {
                        chunk.blocks[this.getBlockIndex(lx, MAZE_WALL_TOP, lz)] = 3;
                    }

                    // Grid maze: corridors every 10 blocks, 2 blocks wide
                    const relX = ((wx - PX) % 10 + 10) % 10;
                    const relZ = ((wz - PZ) % 10 + 10) % 10;
                    const isCorridor = relX <= 1 || relZ <= 1;

                    for (let y = MAZE_AIR_BOT; y <= MAZE_AIR_TOP && y < this.chunkHeight; y++) {
                        if (y < 0) continue;
                        chunk.blocks[this.getBlockIndex(lx, y, lz)] = isCorridor ? 0 : 3;
                    }
                }

                // ── 4. Entrance opening on south WALL
                //       Vertical 2x2 doorway (2 wide in X, 2 tall in Y) punched
                //       through every sand layer at z = PYRAMID_MAX_Z so you
                //       walk straight in from outside into the maze corridor.
                if (wx >= PX - 1 && wx <= PX && wz === PYRAMID_MAX_Z) {
                    for (let y = baseY; y <= baseY + 1 && y < this.chunkHeight; y++) {
                        if (y >= 0) chunk.blocks[this.getBlockIndex(lx, y, lz)] = 0;
                    }
                }

                // ── 5. Staircase from maze to grand chamber ──────────
                //       Runs along x = PX, z from (PZ - 18) up to (PZ),
                //       each z step rises ~1 block in y.
                if (wx >= PX - 1 && wx <= PX + 1) {
                    const stairZMin = PZ - 18;
                    const stairZMax = PZ;
                    if (wz >= stairZMin && wz <= stairZMax) {
                        const t = (wz - stairZMin) / (stairZMax - stairZMin); // 0..1
                        const stepY = Math.round(MAZE_AIR_BOT + t * (CHAM_BOT - MAZE_AIR_BOT));
                        // Step block at stepY, air above for head room
                        for (let y = Math.max(0, stepY); y <= Math.min(stepY + 3, this.chunkHeight - 1); y++) {
                            chunk.blocks[this.getBlockIndex(lx, y, lz)] = (y === stepY) ? blockType : 0;
                        }
                    }
                }

                // ── 6. A torch every 20 blocks inside maze corridors ─
                //       (placed at y = MAZE_AIR_BOT + 2 so the flame is
                //        at eye level in the 3-tall corridor)
                if (inMaze) {
                    const relX = ((wx - PX) % 20 + 20) % 20;
                    const relZ = ((wz - PZ) % 20 + 20) % 20;
                    const torchY = MAZE_AIR_BOT + 2;
                    if (relX === 0 && relZ === 0 && torchY >= 0 && torchY < this.chunkHeight) {
                        chunk.blocks[this.getBlockIndex(lx, torchY, lz)] = 25; // torch
                    }
                }
            }
        }
    }

    buildCastleInChunk(chunk, cx, cz) {
        if (this.worldType !== 'default') return;

        const sourceCastleKey = (typeof window !== 'undefined' && window.STRUCTURES)
            ? (window.STRUCTURES.castle ? 'castle' : (window.STRUCTURES.my_structure_2 ? 'my_structure_2' : null))
            : null;
        const sourceCastle = (sourceCastleKey && typeof window !== 'undefined' && window.STRUCTURES)
            ? window.STRUCTURES[sourceCastleKey]
            : null;
        if (!sourceCastle || !Array.isArray(sourceCastle.ops)) return;
        if (sourceCastle.dimension && sourceCastle.dimension !== 'default') return;

        // Keep the castle clearly west of origin/spawn.
        const targetAnchorX = -192;
        const targetAnchorZ = -24;
        const targetAnchorY = Math.max(4, this.getTerrainHeight(targetAnchorX, targetAnchorZ) + 1);

        const castleDef = {
            ...sourceCastle,
            __structureKey: sourceCastleKey,
            anchorX: targetAnchorX,
            anchorY: targetAnchorY,
            anchorZ: targetAnchorZ
        };

        this.applyMegaStructureToChunk(chunk, cx, cz, castleDef);
    }

    normalizeConnecterDirection(rawDir) {
        const dir = (typeof rawDir === 'string' ? rawDir : '').toLowerCase();
        if (dir === 'n' || dir === 's' || dir === 'w' || dir === 'e') return dir;
        return null;
    }

    normalizeConnecterLetter(rawLetter) {
        const letter = (typeof rawLetter === 'string' ? rawLetter : '').toLowerCase().trim();
        return /^[a-z]$/.test(letter) ? letter : null;
    }

    getConnecterDirectionVector(dir) {
        if (dir === 'n') return { dx: 0, dz: -1 };
        if (dir === 's') return { dx: 0, dz: 1 };
        if (dir === 'w') return { dx: -1, dz: 0 };
        if (dir === 'e') return { dx: 1, dz: 0 };
        return { dx: 0, dz: 0 };
    }

    getOppositeConnecterDirection(dir) {
        if (dir === 'n') return 's';
        if (dir === 's') return 'n';
        if (dir === 'w') return 'e';
        if (dir === 'e') return 'w';
        return null;
    }

    rotateXZQuarterTurns(rx, rz, turns) {
        const t = ((turns % 4) + 4) % 4;
        if (t === 0) return { x: rx, z: rz };
        if (t === 1) return { x: -rz, z: rx };
        if (t === 2) return { x: -rx, z: -rz };
        return { x: rz, z: -rx };
    }

    rotateDirectionQuarterTurns(dir, turns) {
        const dirs = ['n', 'e', 's', 'w'];
        const idx = dirs.indexOf(dir);
        if (idx < 0) return dir;
        const t = ((turns % 4) + 4) % 4;
        return dirs[(idx + t) % 4];
    }

    transformStructureOpForRotation(op, turns, offsetX, offsetY, offsetZ) {
        if (op[0] === 'fill') {
            const [, rx1, ry1, rz1, rx2, ry2, rz2, blockId] = op;
            const p1 = this.rotateXZQuarterTurns(rx1, rz1, turns);
            const p2 = this.rotateXZQuarterTurns(rx2, rz2, turns);
            return ['fill', p1.x + offsetX, ry1 + offsetY, p1.z + offsetZ, p2.x + offsetX, ry2 + offsetY, p2.z + offsetZ, blockId];
        }

        if (op[0] === 'block') {
            const [, rx, ry, rz, blockId] = op;
            const p = this.rotateXZQuarterTurns(rx, rz, turns);
            return ['block', p.x + offsetX, ry + offsetY, p.z + offsetZ, blockId];
        }

        if (op[0] === 'connecter' || op[0] === 'connector') {
            const [, rx, ry, rz, blockId, dir, letter] = op;
            const p = this.rotateXZQuarterTurns(rx, rz, turns);
            const rotatedDir = this.rotateDirectionQuarterTurns(this.normalizeConnecterDirection(dir), turns);
            const normalizedLetter = this.normalizeConnecterLetter(letter);
            return ['connecter', p.x + offsetX, ry + offsetY, p.z + offsetZ, blockId, rotatedDir, normalizedLetter];
        }

        return op.slice();
    }

    extractStructureConnecters(structure) {
        if (!structure || !Array.isArray(structure.ops)) return [];

        const out = [];
        for (const op of structure.ops) {
            if (op[0] !== 'connecter' && op[0] !== 'connector') continue;
            if (op.length < 7) continue;

            const codeNum = Number(op[4]);
            if (!Number.isFinite(codeNum)) continue;

            const dir = this.normalizeConnecterDirection(op[5]);
            if (!dir) continue;

            const letter = this.normalizeConnecterLetter(op[6]);
            if (!letter) continue;

            out.push({
                op,
                rx: op[1],
                ry: op[2],
                rz: op[3],
                code: Math.max(1, Math.min(99, Math.floor(codeNum))),
                dir,
                letter
            });
        }

        return out;
    }

    structureSupportsDimension(structure, dimension) {
        if (!structure) return false;
        if (!dimension) return true;

        if (Array.isArray(structure.dimensions)) {
            return structure.dimensions.includes(dimension);
        }

        if (typeof structure.dimension === 'string') {
            return structure.dimension === dimension;
        }

        return true;
    }

    resolveConnectedStructureOps(structure) {
        if (!structure || !Array.isArray(structure.ops)) return [];

        const baseConnecters = this.extractStructureConnecters(structure);
        if (baseConnecters.length === 0) return structure.ops.slice();

        const registry = (typeof window !== 'undefined' && window.STRUCTURES)
            ? window.STRUCTURES
            : null;
        if (!registry) return structure.ops.slice();

        const dimension = structure.dimension || this.worldType;
        const baseKey = structure.__structureKey || null;
        const mergedOps = structure.ops.slice();
        const registryEntries = Object.entries(registry)
            .filter(([, def]) => def && Array.isArray(def.ops));

        for (const a of baseConnecters) {
            const targetDir = this.getOppositeConnecterDirection(a.dir);
            if (!targetDir) continue;

            const outVec = this.getConnecterDirectionVector(a.dir);
            let chosen = null;

            for (const [name, def] of registryEntries) {
                if (baseKey && name === baseKey) continue;
                if (!this.structureSupportsDimension(def, dimension)) continue;

                const candidateConnecters = this.extractStructureConnecters(def);
                if (candidateConnecters.length === 0) continue;

                for (const b of candidateConnecters) {
                    if (b.code !== a.code) continue;
                    // Mandatory safety key: connecter letter must match exactly.
                    if (a.letter !== b.letter) continue;

                    let turns = -1;
                    for (let t = 0; t < 4; t++) {
                        if (this.rotateDirectionQuarterTurns(b.dir, t) === targetDir) {
                            turns = t;
                            break;
                        }
                    }
                    if (turns < 0) continue;

                    chosen = { name, def, b, turns };
                    break;
                }

                if (chosen) break;
            }

            if (!chosen) continue;

            const targetRx = a.rx + outVec.dx;
            const targetRy = a.ry;
            const targetRz = a.rz + outVec.dz;

            const rotatedB = this.rotateXZQuarterTurns(chosen.b.rx, chosen.b.rz, chosen.turns);
            const offsetX = targetRx - rotatedB.x;
            const offsetY = targetRy - chosen.b.ry;
            const offsetZ = targetRz - rotatedB.z;

            for (const op of chosen.def.ops) {
                mergedOps.push(this.transformStructureOpForRotation(op, chosen.turns, offsetX, offsetY, offsetZ));
            }
        }

        return mergedOps;
    }

    applyMegaStructureToChunk(chunk, cx, cz, structure) {
        if (!structure || !Array.isArray(structure.ops)) return;

        const expanded = {
            ...structure,
            ops: this.resolveConnectedStructureOps(structure)
        };

        this.applyStructureToChunk(chunk, cx, cz, expanded);
    }

    // Apply a structure definition (from window.STRUCTURES) to a single chunk.
    // Each op in structure.ops is either:
    //   ["fill",  x1,y1,z1, x2,y2,z2, blockId]  – fill rectangular region
    //   ["block", x,y,z, blockId]                – place one block
    //   ["connecter", x,y,z, blockId(1-99), dir, letter] - touching pair + required a-z safety letter
    // All coordinates are relative to structure.anchorX/Y/Z.
    applyStructureToChunk(chunk, cx, cz, structure) {
        const cs = this.chunkSize;
        const ch = this.chunkHeight;
        const cWorldX = cx * cs;
        const cWorldZ = cz * cs;
        const ax = structure.anchorX || 0;
        const ay = structure.anchorY || 0;
        const az = structure.anchorZ || 0;

        for (const op of structure.ops) {
            if (op[0] === 'fill') {
                const [, rx1, ry1, rz1, rx2, ry2, rz2, blockId] = op;
                const wx1 = ax + Math.min(rx1, rx2);
                const wx2 = ax + Math.max(rx1, rx2);
                const wy1 = ay + Math.min(ry1, ry2);
                const wy2 = ay + Math.max(ry1, ry2);
                const wz1 = az + Math.min(rz1, rz2);
                const wz2 = az + Math.max(rz1, rz2);

                const lxStart = Math.max(wx1, cWorldX) - cWorldX;
                const lxEnd   = Math.min(wx2, cWorldX + cs - 1) - cWorldX;
                const lzStart = Math.max(wz1, cWorldZ) - cWorldZ;
                const lzEnd   = Math.min(wz2, cWorldZ + cs - 1) - cWorldZ;

                if (lxStart > lxEnd || lzStart > lzEnd) continue; // chunk not in range

                const wyStart = Math.max(wy1, 0);
                const wyEnd   = Math.min(wy2, ch - 1);

                for (let lx = lxStart; lx <= lxEnd; lx++) {
                    for (let lz = lzStart; lz <= lzEnd; lz++) {
                        for (let wy = wyStart; wy <= wyEnd; wy++) {
                            chunk.blocks[this.getBlockIndex(lx, wy, lz)] = blockId;
                        }
                    }
                }
            } else if (op[0] === 'block') {
                const [, rx, ry, rz, blockId] = op;
                const wx = ax + rx;
                const wz = az + rz;
                const wy = ay + ry;
                const lx = wx - cWorldX;
                const lz = wz - cWorldZ;
                if (lx >= 0 && lx < cs && lz >= 0 && lz < cs && wy >= 0 && wy < ch) {
                    chunk.blocks[this.getBlockIndex(lx, wy, lz)] = blockId;
                }
            } else if (op[0] === 'connecter' || op[0] === 'connector') {
                const [, rx, ry, rz, rawBlockId, rawDir] = op;
                const parsedId = Number(rawBlockId);
                if (!Number.isFinite(parsedId)) continue;

                // Connecter block code is clamped to the user-requested 1..99 range.
                const blockId = Math.max(1, Math.min(99, Math.floor(parsedId)));
                const dir = (typeof rawDir === 'string' ? rawDir : '').toLowerCase();

                let dx = 0;
                let dz = 0;
                if (dir === 'n') dz = -1;
                else if (dir === 's') dz = 1;
                else if (dir === 'w') dx = -1;
                else if (dir === 'e') dx = 1;
                else continue;

                const positions = [
                    [ax + rx, ay + ry, az + rz],
                    [ax + rx + dx, ay + ry, az + rz + dz]
                ];

                for (const [wx, wy, wz] of positions) {
                    const lx = wx - cWorldX;
                    const lz = wz - cWorldZ;
                    if (lx >= 0 && lx < cs && lz >= 0 && lz < cs && wy >= 0 && wy < ch) {
                        chunk.blocks[this.getBlockIndex(lx, wy, lz)] = blockId;
                    }
                }
            }
        }
    }

    getBlockIndex(x, y, z) {
        return y * this.chunkSize * this.chunkSize + z * this.chunkSize + x;
    }

    getLightIndex(x, y, z) {
        return y * this.chunkSize * this.chunkSize + z * this.chunkSize + x;
    }

    getBlock(wx, wy, wz) {
        if (wy < 0 || wy >= this.chunkHeight) return 0; // Out of bounds = air

        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        const lx = ((wx % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const lz = ((wz % this.chunkSize) + this.chunkSize) % this.chunkSize;

        const chunk = this.getChunk(cx, cz);
        return chunk.blocks[this.getBlockIndex(lx, wy, lz)] || 0;
    }

    setBlock(wx, wy, wz, blockType) {
        if (wy < 0 || wy >= this.chunkHeight) return;

        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        const lx = ((wx % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const lz = ((wz % this.chunkSize) + this.chunkSize) % this.chunkSize;

        const chunk = this.getChunk(cx, cz);
        const idx = this.getBlockIndex(lx, wy, lz);
        const prevBlock = chunk.blocks[idx];
        chunk.blocks[idx] = blockType;
        chunk.modified = true;
        chunk.playerModified = true; // Mark this chunk as modified by player action

        // Recompute skylight for this and neighbors
        this.recomputeLightingAround(cx, cz);

        // If a torch/magic candle was added or removed, only recompute lighting around it (not globally)
        const isEmissive = (b) => b === 25 || b === 29 || b === 64 || b === 65;
        if (isEmissive(prevBlock) || isEmissive(blockType)) {
            // Only recompute block lights in nearby chunks to avoid global recalc lag
            this.propagateBlockLightLocalAround(wx, wy, wz);
        }
    }

    propagateBlockLightLocalAround(wx, wy, wz) {
        // Recompute block lights only in a 3x3 area of chunks around the light source
        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        
        for (let ocx = cx - 1; ocx <= cx + 1; ocx++) {
            for (let ocz = cz - 1; ocz <= cz + 1; ocz++) {
                const chunk = this.getChunk(ocx, ocz);
                if (chunk && chunk.blockLight) {
                    // Clear blockLight in this chunk
                    chunk.blockLight.fill(0);
                }
            }
        }
        
        // Propagate from sources in nearby chunks only
        for (let ocx = cx - 1; ocx <= cx + 1; ocx++) {
            for (let ocz = cz - 1; ocz <= cz + 1; ocz++) {
                const chunk = this.getChunk(ocx, ocz);
                if (chunk) {
                    try {
                        this.propagateBlockLightFromSources(chunk, ocx, ocz);
                    } catch (e) {
                        console.error(`Error propagating block light at chunk (${ocx}, ${ocz}):`, e);
                    }
                }
            }
        }
    }

    isTransparentForLight(blockType) {
        // Non-solid and light-permeable blocks allow light through
        return !this.isBlockSolid(blockType);
    }

    getChunkAndLocal(wx, wy, wz) {
        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        const lx = ((wx % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const lz = ((wz % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const chunk = this.chunks.get(this.getChunkKey(cx, cz));
        if (!chunk) return null;
        return { chunk, cx, cz, lx, ly: wy, lz };
    }

    getSkyLight(wx, wy, wz) {
        if (wy < 0 || wy >= this.chunkHeight) return 0;
        const data = this.getChunkAndLocal(wx, wy, wz);
        if (!data) return 0;
        return data.chunk.skyLight[this.getLightIndex(data.lx, wy, data.lz)] || 0;
    }

    getBlockLight(wx, wy, wz) {
        if (wy < 0 || wy >= this.chunkHeight) return 0;
        const data = this.getChunkAndLocal(wx, wy, wz);
        if (!data) return 0;
        return data.chunk.blockLight[this.getLightIndex(data.lx, wy, data.lz)] || 0;
    }

    getCombinedLight(wx, wy, wz) {
        const skyRaw = this.getSkyLight(wx, wy, wz) / this.maxLightLevel;
        const sky = skyRaw * (this.sunlightFactor || 1.0);
        const blockRaw = this.getBlockLight(wx, wy, wz) / this.maxLightLevel;
        // Brighter block lights in Astral; allow higher-than-normal brightness
        const blockBoost = (this.worldType === 'astral') ? 1.5 : 1.35;
        const block = blockRaw * blockBoost;
        // Let block light dominate, skylight provides base
        let combined = Math.max(block, sky);
        // Permit up to 1.50 brightness in Astral
        const maxCombined = (this.worldType === 'astral') ? 1.5 : 1.0;
        combined = Math.min(maxCombined, combined);
        // Always ensure at least ambient floor
        const ambient = this.ambientMinimum || 0.15;
        return Math.max(combined, ambient);
    }

    computeSkylightForChunk(chunk, cx, cz) {
        const cs = this.chunkSize;
        const ch = this.chunkHeight;
        chunk.skyLight.fill(0);

        // Simple vertical skylight: open sky columns get max light that decays downward until blocked
        for (let x = 0; x < cs; x++) {
            for (let z = 0; z < cs; z++) {
                let light = this.maxLightLevel;
                for (let y = ch - 1; y >= 0; y--) {
                    const idx = this.getLightIndex(x, y, z);
                    const blockType = chunk.blocks[idx];
                    if (this.isTransparentForLight(blockType)) {
                        chunk.skyLight[idx] = light;
                        // Decay per block; astral stays brighter/deeper
                        const decay = (this.worldType === 'astral') ? 0.995 : 0.98;
                        if (light > 0) light *= decay;
                    } else {
                        // Opaque blocks block skylight; reset below
                        light = 0;
                        chunk.skyLight[idx] = 0;
                    }
                }
            }
        }

        // Horizontal/vertical skylight flood-fill so side-exposed blocks receive sky light
        const queue = [];
        for (let x = 0; x < cs; x++) {
            for (let z = 0; z < cs; z++) {
                for (let y = 0; y < ch; y++) {
                    const level = chunk.skyLight[this.getLightIndex(x, y, z)];
                    if (level > 1) {
                        queue.push({ wx: cx * cs + x, wy: y, wz: cz * cs + z, level });
                    }
                }
            }
        }

        const dirs = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];

        while (queue.length > 0) {
            const { wx, wy, wz, level } = queue.shift();
            const nextLevel = level - 1;
            if (nextLevel <= 0) continue;

            for (const [dx, dy, dz] of dirs) {
                const nx = wx + dx;
                const ny = wy + dy;
                const nz = wz + dz;
                if (ny < 0 || ny >= this.chunkHeight) continue;
                const target = this.getChunkAndLocal(nx, ny, nz);
                if (!target) continue;
                const tidx = this.getLightIndex(target.lx, ny, target.lz);
                const blockType = target.chunk.blocks[tidx];
                if (!this.isTransparentForLight(blockType)) continue;
                if ((target.chunk.skyLight[tidx] || 0) >= nextLevel) continue;
                target.chunk.skyLight[tidx] = nextLevel;
                queue.push({ wx: nx, wy: ny, wz: nz, level: nextLevel });
            }
        }
    }

    propagateBlockLightFromSources(chunk, cx, cz) {
        const cs = this.chunkSize;
        const ch = this.chunkHeight;
        chunk.blockLight.fill(0);

        const queue = [];
        const pushLight = (wx, wy, wz, level) => {
            if (wy < 0 || wy >= ch || level <= 0) return;
            const target = this.getChunkAndLocal(wx, wy, wz);
            if (!target) return;
            const idx = this.getLightIndex(target.lx, wy, target.lz);
            if (target.chunk.blockLight[idx] >= level) return;
            target.chunk.blockLight[idx] = level;
            queue.push({ wx, wy, wz, level });
        };

        // Seed with emissive blocks (torch=25, magic candle=29, sconces=64/65)
        for (let x = 0; x < cs; x++) {
            for (let z = 0; z < cs; z++) {
                for (let y = 0; y < ch; y++) {
                    const idx = this.getLightIndex(x, y, z);
                    const blockType = chunk.blocks[idx];
                    if (blockType === 25 || blockType === 29 || blockType === 64 || blockType === 65) {
                        const wx = cx * cs + x;
                        const wz = cz * cs + z;
                        const wy = y;
                        pushLight(wx, wy, wz, this.maxLightLevel);
                    }
                }
            }
        }

        // 6-direction flood fill with decay
        const dirs = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];

        while (queue.length > 0) {
            const { wx, wy, wz, level } = queue.shift();
            const nextLevel = level - 1;
            if (nextLevel <= 0) continue;

            for (const [dx, dy, dz] of dirs) {
                const nx = wx + dx;
                const ny = wy + dy;
                const nz = wz + dz;
                const neighbor = this.getChunkAndLocal(nx, ny, nz);
                if (!neighbor) continue;
                const nIdx = this.getLightIndex(neighbor.lx, ny, neighbor.lz);
                const blockType = neighbor.chunk.blocks[nIdx];
                if (!this.isTransparentForLight(blockType)) continue;
                if (neighbor.chunk.blockLight[nIdx] >= nextLevel) continue;
                neighbor.chunk.blockLight[nIdx] = nextLevel;
                queue.push({ wx: nx, wy: ny, wz: nz, level: nextLevel });
            }
        }
    }

    computeLightingForChunk(cx, cz) {
        const key = this.getChunkKey(cx, cz);
        const chunk = this.chunks.get(key);
        if (!chunk) return;
        this.computeSkylightForChunk(chunk, cx, cz);
        this.propagateBlockLightFromSources(chunk, cx, cz);
    }

    recomputeLightingAround(cx, cz) {
        // Recompute this chunk and its immediate neighbors for light continuity
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const k = this.getChunkKey(cx + dx, cz + dz);
                if (this.chunks.has(k)) {
                    this.computeLightingForChunk(cx + dx, cz + dz);
                }
            }
        }
    }

    // Recompute block lights across all loaded chunks.
    // Clears existing blockLight and re-propagates from all emissive sources.
    recomputeAllBlockLights() {
        // Clear blockLight in all chunks first to avoid stale values
        for (const chunk of this.chunks.values()) {
            if (chunk && chunk.blockLight) {
                chunk.blockLight.fill(0);
            }
        }
        // Propagate from sources in every chunk; propagation crosses chunk boundaries
        for (const chunk of this.chunks.values()) {
            if (!chunk) continue;
            const { cx, cz } = chunk;
            this.propagateBlockLightFromSources(chunk, cx, cz);
        }
    }

    isBlockSolid(blockType) {
        // Treat fluids and decorative blocks as non-solid for face culling/collision.
        return blockType > 0 && blockType !== 5 && blockType !== 34 && blockType !== 11 && blockType !== 25 && blockType !== 29 && blockType !== 46 && blockType !== 47 && blockType !== 48 && blockType !== 64 && blockType !== 65;
    }

    /**
     * Return true if the given block type represents something the player
     * should be able to place in the world.  The inventory contains both
     * blocks and "items" (scrolls, food, equipment, etc), and previously
     * every item could be selected and then placed by right‑clicking.  That
     * allowed the player to drop pork, helmets, scrolls etc as a solid block
     * which is not desirable.  This helper centralises the decision and is
     * used by {@link placeBlock}.  The list is kept in a set so it is easy to
     * review and extend as new blocks are added.
     */
    isBlockPlaceable(blockType) {
        if (typeof blockType !== 'number' || blockType <= 0) return false;
        // valid placeable types (terrain, functional blocks, torches, chests,
        // ores, lava, etc).  Any type not listed here is considered an "item"
        // and will be ignored when the player attempts to place it.
        const placeable = new Set([
            1, 2, 3, 4,    // dirt, grass, stone, sand
            5,              // water (bucket behaviour may vary)
            6, 7, 8, 9, 10, // wood, bricks, ruby, clay, snow
            11, 12, 13,     // leafs, sapphire, plank
            24,             // coal ore/block
            25,             // torch
            26,             // chest
            27,             // mana orb (placeable block)
            29,             // magic candle
            33,             // grim stone (fairia)
            34,             // lava
            40,             // TNT
            42,             // cauldron
            45,             // structure block
            47,             // wood door
            48,             // dungeon door
            56,             // connecter block
            57, 58, 59, 60, 61, 62, 63 // rainbow cloth variants
            ,64, 65         // red/blue sconces
        ]);
        return placeable.has(blockType);
    }

    getVisibleBlocksInChunk(cx, cz) {
        const chunk = this.getChunk(cx, cz);
        const visibleBlocks = [];

        for (let x = 0; x < this.chunkSize; x++) {
            for (let y = 0; y < this.chunkHeight; y++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    const blockType = chunk.blocks[this.getBlockIndex(x, y, z)];
                    if (blockType === 0) continue; // Skip air

                    // Check if any face is exposed
                    const wx = cx * this.chunkSize + x;
                    const wy = y;
                    const wz = cz * this.chunkSize + z;

                    let hasVisibleFace = false;
                    // Check 6 neighbors
                    if (this.getBlock(wx + 1, wy, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx - 1, wy, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy + 1, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy - 1, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy, wz + 1) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy, wz - 1) === 0) hasVisibleFace = true;

                    if (hasVisibleFace) {
                        visibleBlocks.push({ x: wx, y: wy, z: wz, blockType });
                    }
                }
            }
        }

        return visibleBlocks;
    }
}

class BlockMesher {
    constructor(world, textureAtlas) {
        this.world = world;
        this.textureAtlas = textureAtlas;
        
        // Define texture UVs for each block type
        // Each block type gets a 64x64 region in a 256x256 atlas (4x4 grid)
        this.blockTextureUVs = {
            1: { x: 0, y: 0 },      // Dirt
            2: { x: 1, y: 0 },      // Grass
            3: { x: 2, y: 0 },      // Stone
            4: { x: 3, y: 0 },      // Sand
            5: { x: 0, y: 1 },      // Water
            6: { x: 1, y: 1 },      // Wood
            7: { x: 2, y: 1 },      // Bricks
            8: { x: 3, y: 1 },      // Ruby
            9: { x: 0, y: 2 },      // Clay
            10: { x: 1, y: 2 },     // Snow
            11: { x: 2, y: 2 },     // Leafs
            12: { x: 3, y: 2 },     // Sapphire
            13: { x: 2, y: 3 },     // Plank
            24: { x: 0, y: 3 },     // Coal
            25: { x: 1, y: 3 },     // Torch
            29: { x: 1, y: 3 },     // Magic candle (reuse torch tile)
            30: { x: 2, y: 0 },     // Chisel uses stone tile
            31: { x: 1, y: 2 },     // Cloud Pillow uses snow tile
            33: { x: 0, y: 3 },     // Grim Stone (use coal texture until dedicated art exists)
            34: { x: 0, y: 1 },     // Lava (use water texture as placeholder)
            40: { x: 3, y: 1 },     // TNT (reuse ruby tile – red)
            42: { x: 0, y: 2 },     // Cauldron (reuse clay tile)
            45: { x: 3, y: 3 },     // Structure Block (distinctive purple tile)
            56: { x: 3, y: 3 },     // Connecter (reuse structure block tile)
            57: { x: 3, y: 0 },     // Red cloth (sand base tile, tinted)
            58: { x: 3, y: 0 },     // Orange cloth
            59: { x: 3, y: 0 },     // Yellow cloth
            60: { x: 3, y: 0 },     // Green cloth
            61: { x: 3, y: 0 },     // Blue cloth
            62: { x: 3, y: 0 },     // Indigo cloth
            63: { x: 3, y: 0 },     // Violet cloth
            64: { x: 1, y: 3 },     // Red sconce (torch tile, red emissive)
            65: { x: 1, y: 3 }      // Blue sconce (torch tile, blue emissive)
        };

        // Per-block tint multipliers for cloth color variants.
        this.blockTintColors = {
            57: { r: 1.0, g: 0.30, b: 0.30 },
            58: { r: 1.0, g: 0.60, b: 0.25 },
            59: { r: 1.0, g: 0.95, b: 0.30 },
            60: { r: 0.35, g: 0.95, b: 0.35 },
            61: { r: 0.35, g: 0.60, b: 1.0 },
            62: { r: 0.40, g: 0.40, b: 0.95 },
            63: { r: 0.75, g: 0.45, b: 1.0 }
        };
        
        this.textureGridSize = 4; // 4x4 grid in atlas
    }

    getBlockUVs(blockType) {
        const uv = this.blockTextureUVs[blockType] || { x: 0, y: 0 };
        const tileSize = 1 / this.textureGridSize;
        
        return {
            minU: uv.x * tileSize,
            maxU: (uv.x + 1) * tileSize,
            minV: 1 - (uv.y + 1) * tileSize,
            maxV: 1 - uv.y * tileSize
        };
    }
    
    getDefaultUVs() {
        // Standard full texture UVs (for backwards compatibility)
        return {
            minU: 0,
            maxU: 1,
            minV: 0,
            maxV: 1
        };
    }

    createChunkMesh(cx, cz) {
        console.log(`Creating mesh for chunk ${cx},${cz}`);
        const geometry = new THREE.BufferGeometry();
        const positions = [];
        const uvs = [];
        const colors = [];
        const indices = [];
        const waterPositions = [];
        const waterUvs = [];
        const waterColors = [];
        const waterIndices = [];
        const portalPositions = [];
        const portalUvs = [];
        const portalColors = [];
        const portalIndices = [];
        const leafPositions = [];
        const leafUvs = [];
        const leafColors = [];
        const leafIndices = [];
        const torchPositions = [];
        const torchUvs = [];
        const torchColors = [];
        const torchIndices = [];
        const magicTorchPositions = [];
        const magicTorchUvs = [];
        const magicTorchColors = [];
        const magicTorchIndices = [];
        const redSconcePositions = [];
        const redSconceUvs = [];
        const redSconceColors = [];
        const redSconceIndices = [];
        const blueSconcePositions = [];
        const blueSconceUvs = [];
        const blueSconceColors = [];
        const blueSconceIndices = [];
        const lavaPositions = [];
        const lavaUvs = [];
        const lavaColors = [];
        const lavaIndices = [];
        // linePositions removed — outlines drawn only on the targeted block

        const visibleBlocks = this.world.getVisibleBlocksInChunk(cx, cz);
        console.log(`Found ${visibleBlocks.length} visible blocks`);
        // Debug: remember first visible block for inspection
        const debugFirstBlock = visibleBlocks.length ? visibleBlocks[0] : null;
        let vertexCount = 0;

        const scale = this.world.tileSize;
        const chunkOriginX = cx * this.world.chunkSize;
        const chunkOriginZ = cz * this.world.chunkSize;

        for (const block of visibleBlocks) {
            const { x, y, z, blockType } = block; // x,z are world coords

            // Separate water, lava, and leafs from other blocks
            if (blockType === 5) {
                this.addBlockFaces(x, y, z, blockType, scale, waterPositions, waterUvs, waterColors, waterIndices, null);
            } else if (blockType === 46) {
                this.addBlockFaces(x, y, z, blockType, scale, portalPositions, portalUvs, portalColors, portalIndices, null);
            } else if (blockType === 34) {
                this.addBlockFaces(x, y, z, blockType, scale, lavaPositions, lavaUvs, lavaColors, lavaIndices, null);
            } else if (blockType === 11) {
                this.addBlockFaces(x, y, z, blockType, scale, leafPositions, leafUvs, leafColors, leafIndices, null);
            } else if (blockType === 25) {
                // Torch special rendering as 3 small cubes into separate emissive torch mesh
                this.addTorchGeometry(x, y, z, scale, torchPositions, torchUvs, torchColors, torchIndices, null);
            } else if (blockType === 29) {
                // Magic candle uses torch mesh but blue/silver material
                this.addTorchGeometry(x, y, z, scale, magicTorchPositions, magicTorchUvs, magicTorchColors, magicTorchIndices, null);
            } else if (blockType === 64) {
                // Red sconce uses torch-like geometry with red emissive material.
                this.addTorchGeometry(x, y, z, scale, redSconcePositions, redSconceUvs, redSconceColors, redSconceIndices, null);
            } else if (blockType === 65) {
                // Blue sconce uses torch-like geometry with blue emissive material.
                this.addTorchGeometry(x, y, z, scale, blueSconcePositions, blueSconceUvs, blueSconceColors, blueSconceIndices, null);
            } else {
                // For each visible block, emit quads for exposed faces
                this.addBlockFaces(x, y, z, blockType, scale, positions, uvs, colors, indices, null);
            }
        }

        console.log(`Mesh has ${positions.length / 3} vertices, ${indices.length} indices`);
        
        if (positions.length === 0 && waterPositions.length === 0 && portalPositions.length === 0 && lavaPositions.length === 0) {
            console.log('No positions, returning null mesh');
            return null;
        }

        // Create main mesh (non-water blocks)
        let mesh = null;
        if (positions.length > 0) {
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
            geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
            
            let indexArray;
            if (indices.length < 65535) {
                indexArray = new Uint16Array(indices);
            } else {
                indexArray = new Uint32Array(indices);
            }
            geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
            geometry.computeVertexNormals();

            const material = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                side: THREE.DoubleSide,
                vertexColors: true
            });

            mesh = new THREE.Mesh(geometry, material);
        }

        // Create water mesh (transparent)
        if (waterPositions.length > 0) {
            const waterGeometry = new THREE.BufferGeometry();
            waterGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(waterPositions), 3));
            waterGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(waterUvs), 2));
            waterGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(waterColors), 3));
            
            let waterIndexArray;
            if (waterIndices.length < 65535) {
                waterIndexArray = new Uint16Array(waterIndices);
            } else {
                waterIndexArray = new Uint32Array(waterIndices);
            }
            waterGeometry.setIndex(new THREE.BufferAttribute(waterIndexArray, 1));
            waterGeometry.computeVertexNormals();

            const waterMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0x0099FF,
                transparent: true,
                opacity: 0.6,
                side: THREE.DoubleSide,
                vertexColors: true
            });

            const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
            
            // If we have a main mesh, add water as a child; otherwise water is the main mesh
            if (mesh) {
                mesh.add(waterMesh);
            } else {
                mesh = waterMesh;
            }
        }

        // Create portal mesh (pitch-black fluid-like surface)
        if (portalPositions.length > 0) {
            const portalGeometry = new THREE.BufferGeometry();
            portalGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(portalPositions), 3));
            portalGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(portalUvs), 2));
            portalGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(portalColors), 3));

            let portalIndexArray;
            if (portalIndices.length < 65535) {
                portalIndexArray = new Uint16Array(portalIndices);
            } else {
                portalIndexArray = new Uint32Array(portalIndices);
            }
            portalGeometry.setIndex(new THREE.BufferAttribute(portalIndexArray, 1));
            portalGeometry.computeVertexNormals();

            const portalMaterial = new THREE.MeshLambertMaterial({
                color: 0x000000,
                transparent: true,
                opacity: 0.9,
                side: THREE.DoubleSide,
                vertexColors: false
            });

            const portalMesh = new THREE.Mesh(portalGeometry, portalMaterial);

            if (mesh) {
                mesh.add(portalMesh);
            } else {
                mesh = portalMesh;
            }
        }

        // Create lava mesh (glowing orange-red fluid)
        if (lavaPositions.length > 0) {
            const lavaGeometry = new THREE.BufferGeometry();
            lavaGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lavaPositions), 3));
            lavaGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(lavaUvs), 2));
            lavaGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lavaColors), 3));
            
            let lavaIndexArray;
            if (lavaIndices.length < 65535) {
                lavaIndexArray = new Uint16Array(lavaIndices);
            } else {
                lavaIndexArray = new Uint32Array(lavaIndices);
            }
            lavaGeometry.setIndex(new THREE.BufferAttribute(lavaIndexArray, 1));
            lavaGeometry.computeVertexNormals();

            const lavaMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0xFF6600,
                transparent: true,
                opacity: 0.75,
                emissive: 0xFF4500,
                emissiveIntensity: 0.8,
                side: THREE.DoubleSide,
                vertexColors: true
            });

            const lavaMesh = new THREE.Mesh(lavaGeometry, lavaMaterial);
            
            // If we have a main mesh, add lava as a child; otherwise lava is the main mesh
            if (mesh) {
                mesh.add(lavaMesh);
            } else {
                mesh = lavaMesh;
            }
        }

        // Create leafs mesh (semi-transparent green)
        if (leafPositions.length > 0) {
            const leafGeometry = new THREE.BufferGeometry();
            leafGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(leafPositions), 3));
            leafGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(leafUvs), 2));
            
            let leafIndexArray;
            if (leafIndices.length < 65535) {
                leafIndexArray = new Uint16Array(leafIndices);
            } else {
                leafIndexArray = new Uint32Array(leafIndices);
            }
            leafGeometry.setIndex(new THREE.BufferAttribute(leafIndexArray, 1));
            leafGeometry.computeVertexNormals();

            const leafMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0x22AA22, // Green
                transparent: true,
                opacity: 0.75,
                alphaTest: 0.5,
                side: THREE.DoubleSide
            });

            const leafMesh = new THREE.Mesh(leafGeometry, leafMaterial);
            
            // Add leafs to scene hierarchy
            if (mesh) {
                mesh.add(leafMesh);
            } else {
                mesh = leafMesh;
            }
        }

        // Create torch mesh with emissive material so torches look bright
        if (torchPositions.length > 0) {
            const torchGeometry = new THREE.BufferGeometry();
            torchGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(torchPositions), 3));
            torchGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(torchUvs), 2));
            let torchIndexArray;
            if (torchIndices.length < 65535) {
                torchIndexArray = new Uint16Array(torchIndices);
            } else {
                torchIndexArray = new Uint32Array(torchIndices);
            }
            torchGeometry.setIndex(new THREE.BufferAttribute(torchIndexArray, 1));
            torchGeometry.computeVertexNormals();

            const torchMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0xFFD36B, // warm gold tone
                emissive: new THREE.Color(0xFFAA33),
                emissiveIntensity: 2.0,
                side: THREE.DoubleSide
            });

            const torchMesh = new THREE.Mesh(torchGeometry, torchMaterial);
            if (mesh) {
                mesh.add(torchMesh);
            } else {
                mesh = torchMesh;
            }
        }

        // Create magic candle mesh (blue/silver emissive)
        if (magicTorchPositions.length > 0) {
            const magicGeometry = new THREE.BufferGeometry();
            magicGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(magicTorchPositions), 3));
            magicGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(magicTorchUvs), 2));
            let magicIndexArray;
            if (magicTorchIndices.length < 65535) {
                magicIndexArray = new Uint16Array(magicTorchIndices);
            } else {
                magicIndexArray = new Uint32Array(magicTorchIndices);
            }
            magicGeometry.setIndex(new THREE.BufferAttribute(magicIndexArray, 1));
            magicGeometry.computeVertexNormals();

            const magicMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0x7fb7ff, // blue tint
                emissive: new THREE.Color(0xa6d3ff),
                emissiveIntensity: 2.0,
                side: THREE.DoubleSide
            });

            const magicMesh = new THREE.Mesh(magicGeometry, magicMaterial);
            if (mesh) {
                mesh.add(magicMesh);
            } else {
                mesh = magicMesh;
            }
        }

        if (redSconcePositions.length > 0) {
            const redGeometry = new THREE.BufferGeometry();
            redGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(redSconcePositions), 3));
            redGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(redSconceUvs), 2));
            let redIndexArray;
            if (redSconceIndices.length < 65535) {
                redIndexArray = new Uint16Array(redSconceIndices);
            } else {
                redIndexArray = new Uint32Array(redSconceIndices);
            }
            redGeometry.setIndex(new THREE.BufferAttribute(redIndexArray, 1));
            redGeometry.computeVertexNormals();

            const redMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0xff7a7a,
                emissive: new THREE.Color(0xff2c2c),
                emissiveIntensity: 2.1,
                side: THREE.DoubleSide
            });

            const redMesh = new THREE.Mesh(redGeometry, redMaterial);
            if (mesh) mesh.add(redMesh);
            else mesh = redMesh;
        }

        if (blueSconcePositions.length > 0) {
            const blueGeometry = new THREE.BufferGeometry();
            blueGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(blueSconcePositions), 3));
            blueGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(blueSconceUvs), 2));
            let blueIndexArray;
            if (blueSconceIndices.length < 65535) {
                blueIndexArray = new Uint16Array(blueSconceIndices);
            } else {
                blueIndexArray = new Uint32Array(blueSconceIndices);
            }
            blueGeometry.setIndex(new THREE.BufferAttribute(blueIndexArray, 1));
            blueGeometry.computeVertexNormals();

            const blueMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0x85b8ff,
                emissive: new THREE.Color(0x2d6cff),
                emissiveIntensity: 2.1,
                side: THREE.DoubleSide
            });

            const blueMesh = new THREE.Mesh(blueGeometry, blueMaterial);
            if (mesh) mesh.add(blueMesh);
            else mesh = blueMesh;
        }

        console.log('Mesh created successfully');

        return mesh;
    }

    // Torch as 3 smaller cubes stacked vertically within the voxel
    addTorchGeometry(wx, y, wz, scale, positions, uvs, colors, indices, linePositions) {
        const s = scale;
        const baseX = wx * s;
        const baseY = y * s;
        const baseZ = wz * s;

        // Helper to add a small cube centered at offsets with given size and uv from a block type
        const addSmallCube = (cx, cy, cz, size, uvBlockType) => {
            const uv = this.getBlockUVs(uvBlockType);
            const half = size / 2;
            const px = baseX + cx;
            const py = baseY + cy;
            const pz = baseZ + cz;

            const corners = {
                '000': [px - half, py - half, pz - half],
                '100': [px + half, py - half, pz - half],
                '110': [px + half, py + half, pz - half],
                '010': [px - half, py + half, pz - half],
                '001': [px - half, py - half, pz + half],
                '101': [px + half, py - half, pz + half],
                '111': [px + half, py + half, pz + half],
                '011': [px - half, py + half, pz + half]
            };

            const addQuad = (v0, v1, v2, v3) => {
                const idx = positions.length / 3;
                positions.push(...v0, ...v1, ...v2, ...v3);
                uvs.push(
                    uv.minU, uv.maxV,
                    uv.minU, uv.minV,
                    uv.maxU, uv.minV,
                    uv.maxU, uv.maxV
                );
                // Colors per vertex: flame bright, stick follows local light
                let rf, gf, bf;
                if (uvBlockType === 25) {
                    rf = 1.0; gf = 0.95; bf = 0.85;
                } else {
                    const lf = this.world.getCombinedLight(wx, y, wz);
                    rf = lf; gf = lf; bf = lf;
                }
                colors.push(rf, gf, bf, rf, gf, bf, rf, gf, bf, rf, gf, bf);
                indices.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
            };

            // Always render all faces (tiny cube inside voxel)
            addQuad(corners['000'], corners['010'], corners['110'], corners['100']); // -Z
            addQuad(corners['001'], corners['101'], corners['111'], corners['011']); // +Z
            addQuad(corners['000'], corners['001'], corners['011'], corners['010']); // -X
            addQuad(corners['100'], corners['110'], corners['111'], corners['101']); // +X
            addQuad(corners['000'], corners['100'], corners['101'], corners['001']); // -Y
            addQuad(corners['010'], corners['011'], corners['111'], corners['110']); // +Y

            // Add wireframe edges for this small cube
            if (linePositions) {
                // Bottom square
                linePositions.push(...corners['000'], ...corners['100']);
                linePositions.push(...corners['100'], ...corners['101']);
                linePositions.push(...corners['101'], ...corners['001']);
                linePositions.push(...corners['001'], ...corners['000']);
                // Top square
                linePositions.push(...corners['010'], ...corners['110']);
                linePositions.push(...corners['110'], ...corners['111']);
                linePositions.push(...corners['111'], ...corners['011']);
                linePositions.push(...corners['011'], ...corners['010']);
                // Vertical edges
                linePositions.push(...corners['000'], ...corners['010']);
                linePositions.push(...corners['100'], ...corners['110']);
                linePositions.push(...corners['101'], ...corners['111']);
                linePositions.push(...corners['001'], ...corners['011']);
            }
        };

        // Sizes and positions: make a thin stick and small flame
        const stickSize = s * 0.18; // thin rod width
        const segmentHeight = s * 0.28;
        const centerX = s * 0.5;
        const centerZ = s * 0.5;

        // Two brown segments (use wood block UV 6)
        addSmallCube(centerX, segmentHeight * 0.5, centerZ, stickSize, 6);
        addSmallCube(centerX, segmentHeight * 1.2, centerZ, stickSize, 6);

        // Top gold flame (use torch block UV 25)
        const flameSize = s * 0.22;
        addSmallCube(centerX, segmentHeight * 2.0, centerZ, flameSize, 25);
    }

    addBlockFaces(wx, y, wz, blockType, scale, positions, uvs, colors, indices, linePositions) {
        const uv = this.getBlockUVs(blockType);
        const tint = this.blockTintColors[blockType] || { r: 1, g: 1, b: 1 };

        const s = scale;
        // Use world coordinates directly for vertex positions
        const px = wx * s;
        const py = y * s;
        const pz = wz * s;

        // Helper to add a quad (2 triangles) with a provided light factor
        const addQuad = (v0, v1, v2, v3, lf) => {
            const idx = positions.length / 3;
            positions.push(...v0, ...v1, ...v2, ...v3);
            // Add UV coordinates for the quad
            uvs.push(
                uv.minU, uv.maxV,  // v0 - bottom-left
                uv.minU, uv.minV,  // v1 - top-left
                uv.maxU, uv.minV,  // v2 - top-right
                uv.maxU, uv.maxV   // v3 - bottom-right
            );
            const r = lf * tint.r;
            const g = lf * tint.g;
            const b = lf * tint.b;
            colors.push(r, g, b, r, g, b, r, g, b, r, g, b);
            indices.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
        };

        // Define 8 corners of the cube in world space
        const corners = {
            '000': [px, py, pz],
            '100': [px + s, py, pz],
            '110': [px + s, py + s, pz],
            '010': [px, py + s, pz],
            '001': [px, py, pz + s],
            '101': [px + s, py, pz + s],
            '111': [px + s, py + s, pz + s],
            '011': [px, py + s, pz + s]
        };

        // Use world coordinates for neighbor checks and sample neighbor light per face
        // Front face (-Z)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y, wz - 1))) {
            const lfFront = this.world.getCombinedLight(wx, y, wz - 1);
            addQuad(corners['000'], corners['010'], corners['110'], corners['100'], lfFront);
        }
        // Back face (+Z)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y, wz + 1))) {
            const lfBack = this.world.getCombinedLight(wx, y, wz + 1);
            addQuad(corners['001'], corners['101'], corners['111'], corners['011'], lfBack);
        }
        // Left face (-X)
        if (!this.world.isBlockSolid(this.world.getBlock(wx - 1, y, wz))) {
            const lfLeft = this.world.getCombinedLight(wx - 1, y, wz);
            addQuad(corners['000'], corners['001'], corners['011'], corners['010'], lfLeft);
        }
        // Right face (+X)
        if (!this.world.isBlockSolid(this.world.getBlock(wx + 1, y, wz))) {
            const lfRight = this.world.getCombinedLight(wx + 1, y, wz);
            addQuad(corners['100'], corners['110'], corners['111'], corners['101'], lfRight);
        }
        // Bottom face (-Y)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y - 1, wz))) {
            const lfBottom = this.world.getCombinedLight(wx, y - 1, wz);
            addQuad(corners['000'], corners['100'], corners['101'], corners['001'], lfBottom);
        }
        // Top face (+Y)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y + 1, wz))) {
            const lfTop = this.world.getCombinedLight(wx, y + 1, wz);
            addQuad(corners['010'], corners['011'], corners['111'], corners['110'], lfTop);
        }

        // Add wireframe edges for this block (12 edges of the cube)
        if (linePositions) {
            // Bottom square
            linePositions.push(...corners['000'], ...corners['100']);
            linePositions.push(...corners['100'], ...corners['101']);
            linePositions.push(...corners['101'], ...corners['001']);
            linePositions.push(...corners['001'], ...corners['000']);
            // Top square
            linePositions.push(...corners['010'], ...corners['110']);
            linePositions.push(...corners['110'], ...corners['111']);
            linePositions.push(...corners['111'], ...corners['011']);
            linePositions.push(...corners['011'], ...corners['010']);
            // Vertical edges
            linePositions.push(...corners['000'], ...corners['010']);
            linePositions.push(...corners['100'], ...corners['110']);
            linePositions.push(...corners['101'], ...corners['111']);
            linePositions.push(...corners['001'], ...corners['011']);
        }
    }
}

class Player {
    constructor(survivalMode = false) {
        this.position = new THREE.Vector3(0, 130, 0);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.yaw = 0;
        this.pitch = 0;
        this.speed = 0.15;
            this.sprintSpeed = 0.25; // Speed when sprinting
        this.jumpPower = 0.3;
        this.gravity = 0.015;
        this.onGround = false;
        this.flyMode = false; // Toggle with F6
        this.noClipMode = false; // Mirrors flyMode for explicit no-clip semantics
            // Sprint tracking for double-tap W
            this.lastWPressTime = 0;
            this.wDoubleTapWindow = 300; // ms to detect double-tap
            this.isSprinting = false;
            this.sprintEndTime = 0; // When sprint expires
            this.sprintDuration = 1500; // Sprint lasts 1.5 seconds
            // Agility Cape: double-tap A/D to dash sideways.
            this.lastAPressTime = 0;
            this.lastDPressTime = 0;
            this.sideDoubleTapWindow = 280;
            this.isSideDashing = false;
            this.sideDashDirection = 0; // -1 left, +1 right
            this.sideDashEndTime = 0;
            this.sideDashDuration = 160;
            this.lastSideDashTime = 0;
            this.sideDashCooldown = 450;
            this.sideDashSpeed = 0.62;
        // Collider dimensions (width, height, depth)
            this.size = new THREE.Vector3(0.5, 2.0, 0.5); // 2-block tall player
        this.selectedBlock = 1; // Dirt
        this.wDisabledUntil = 0; // timestamp to ignore forward input when hugging wall

        // Survival mode
        this.survivalMode = survivalMode;
        this.maxHealth = 10;
        this.health = 10;
        this.maxAP = 5;
        this.ap = 5;
        this.baseMaxHealth = 10;
        this.baseMaxAP = 5;
        this.maxMP = 3;
        this.mp = 3;
        this.gold = 0;
        this.level = 1;
        this.maxLevel = 27;
        this.xp = 0;
        this.xpToNext = 100;
        this.isDead = false;
        this.invulnerableUntil = 0; // Damage cooldown

        // Input state
        this.keys = {};
        // Inventory: 30 slots, 0 = empty
        this.inventory = new Array(30).fill(0);
        
        // Equipment slots
        this.equipment = {
            head: 0,
            body: 0,
            legs: 0,
            boots: 0,
            mainHand: 0,
            offHand: 0,
            tool: 0,
            accessory1: 0,
            accessory2: 0,
            accessory3: 0,
            accessory4: 0,
            accessory5: 0,
            accessory6: 0,
            accessory7: 0
        };
        
        // In survival mode, start with empty inventory - must break blocks to collect them
        if (!survivalMode) {
            this.inventory[0] = 1;   // Dirt
            this.inventory[1] = 2;   // Grass
            this.inventory[2] = 3;   // Stone
            this.inventory[3] = 4;   // Sand
            this.inventory[4] = 5;   // Water
            this.inventory[5] = 6;   // Wood
            this.inventory[6] = 7;   // Bricks
            this.inventory[7] = 8;   // Ruby
            this.inventory[8] = 9;   // Clay
            this.inventory[9] = 10;  // Snow
            this.inventory[10] = 11; // Leafs
            this.inventory[11] = 12; // Sapphire
            this.inventory[12] = 29; // Magic candle
        }

        // First-person camera bob state
        this.bobPhase = 0;
        this.bobAmount = 0;

        // Boots enchant state (Cloutump): allow one extra jump mid-air.
        this.usedDoubleJump = false;
        // Rune of the Batter state: mid-air Shift slam.
        this.groundPoundActive = false;
        this.groundPoundUsedThisAir = false;
        this.groundPoundImpactPending = false;
    }

    hasAccessoryEquipped(type) {
        if (!this.equipment) return false;
        for (let i = 1; i <= 7; i++) {
            const slot = this.equipment[`accessory${i}`];
            const slotType = (slot && typeof slot === 'object') ? slot.type : slot;
            if (slotType === type) return true;
        }
        return false;
    }

    spendAP(amount) {
        const cost = Math.max(0, Number(amount) || 0);
        if (cost <= 0) return true;
        if (this.ap < cost) return false;
        this.ap -= cost;
        if (this.gameInstance && typeof this.gameInstance.updateAPBar === 'function') {
            this.gameInstance.updateAPBar();
        }
        return true;
    }

    startSideDash(direction, nowMs) {
        if (!direction) return false;
        const now = Number(nowMs) || ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
        if (now - this.lastSideDashTime < this.sideDashCooldown) return false;
        this.isSideDashing = true;
        this.sideDashDirection = direction < 0 ? -1 : 1;
        this.sideDashEndTime = now + this.sideDashDuration;
        this.lastSideDashTime = now;
        return true;
    }

    update(world, deltaTime) {
        const wasGroundPoundActive = this.groundPoundActive;

                // Check if sprint should expire
                const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                    if (this.isSprinting && now >= this.sprintEndTime) {
                    this.isSprinting = false;
                    console.log('Sprint ended');
                }

        // Detect if player is inside water or portal at feet or head level
        const halfHeight = this.size.y / 2;
        const blockAtFeet = world.getBlock(Math.floor(this.position.x), Math.floor(this.position.y - halfHeight), Math.floor(this.position.z));
        const blockAtHead = world.getBlock(Math.floor(this.position.x), Math.floor(this.position.y + halfHeight - 0.1), Math.floor(this.position.z));
        const inWater = blockAtFeet === 5 || blockAtHead === 5 || blockAtFeet === 46 || blockAtHead === 46;
        this.inWater = inWater;

        // Apply gravity (disabled in fly mode)
        if (!this.flyMode && !this.onGround) {
            const gravityForce = inWater ? this.gravity * 0.35 : this.gravity; // Lighter gravity in water
            this.velocity.y -= gravityForce;
        }

        // Swimming upward: hold space to rise while in water
        if (inWater && this.keys[' ']) {
            const swimAccel = 0.06;
            const maxSwimUp = 0.18;
            this.velocity.y = Math.min(this.velocity.y + swimAccel, maxSwimUp);
        }

        // Limit fall speed while submerged
        if (inWater) {
            this.velocity.y = Math.max(this.velocity.y, -0.12);
        }

        // Movement - use yaw/pitch to determine direction
        const moveDir = new THREE.Vector3();

        const wAllowed = now >= (this.wDisabledUntil || 0);
        const arrowUp = this.keys['arrowup'];
        const arrowDown = this.keys['arrowdown'];
        const wPressed = (this.keys['w'] || (arrowUp && !this.flyMode)) && wAllowed;
        let flyVerticalInput = 0;
        if (wPressed) moveDir.z -= 1;
        if (this.keys['s'] || (arrowDown && !this.flyMode)) moveDir.z += 1;
        if (this.keys['a'] || this.keys['arrowleft']) moveDir.x -= 1;
        if (this.keys['d'] || this.keys['arrowright']) moveDir.x += 1;
        
        // Vertical movement in no-clip fly mode (Space up, Shift down).
        if (this.flyMode) {
            const upPressed = !!(arrowUp || this.keys[' '] || this.keys['space'] || this.keys['spacebar']);
            const downPressed = !!(arrowDown || this.keys['shift']);
            if (upPressed) flyVerticalInput += 1;
            if (downPressed) flyVerticalInput -= 1;
        }

        const currentSpeed = this.isSprinting ? this.sprintSpeed : this.speed;

        if (moveDir.length() > 0) {
            moveDir.normalize();
            
            // Get forward direction from yaw (ignore pitch for movement)
            const forward = new THREE.Vector3(
                Math.sin(this.yaw),
                0,
                Math.cos(this.yaw)
            );
            
            // Get right direction (perpendicular to forward)
            const right = new THREE.Vector3(
                Math.cos(this.yaw),
                0,
                -Math.sin(this.yaw)
            );

            // Calculate movement velocity based on forward/right vectors
            const movement = new THREE.Vector3();
            movement.addScaledVector(forward, moveDir.z);
            movement.addScaledVector(right, moveDir.x);
            movement.normalize();

            this.velocity.x = movement.x * currentSpeed;
            this.velocity.z = movement.z * currentSpeed;
            if (this.flyMode) {
                this.velocity.y = flyVerticalInput * currentSpeed;
            }
        } else {
            this.velocity.x *= 0.85;
            this.velocity.z *= 0.85;
            if (this.flyMode) {
                if (flyVerticalInput !== 0) {
                    this.velocity.y = flyVerticalInput * currentSpeed;
                } else {
                    this.velocity.y *= 0.85;
                }
            }
        }

        // Agility Cape: short sideways burst independent of forward sprint.
        if (this.isSideDashing) {
            if (now >= this.sideDashEndTime) {
                this.isSideDashing = false;
            } else {
                const right = new THREE.Vector3(
                    Math.cos(this.yaw),
                    0,
                    -Math.sin(this.yaw)
                );
                this.velocity.x = right.x * this.sideDashSpeed * this.sideDashDirection;
                this.velocity.z = right.z * this.sideDashSpeed * this.sideDashDirection;
            }
        }

        // Advance camera bob while moving on ground in first-person style movement.
        const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        const movingOnGround = this.onGround && !this.flyMode && horizontalSpeed > 0.02;
        if (movingOnGround) {
            const sprintMul = this.isSprinting ? 2.2 : 1.0;
            this.bobPhase += deltaTime * 12 * sprintMul;
            this.bobAmount = Math.min(1, this.bobAmount + deltaTime * 12);
        } else {
            this.bobAmount = Math.max(0, this.bobAmount - deltaTime * 8);
        }

        // Check collision and apply movement
        // Movement is applied inside resolveCollisions (per-axis sliding)
        // Skip collision checks in fly mode
        if (!this.flyMode) {
            this.resolveCollisions(world);
        } else {
            // In fly mode, just apply velocity directly with no collision
            this.position.add(this.velocity);
        }

        // Ground detection — ensure block top is near player's feet (disabled in fly mode)
        this.onGround = false;
        if (!this.flyMode) {
            const halfY = this.size.y / 2;
            const feetY = this.position.y - halfY; // exact feet world Y

            // Sample blocks under player in a small horizontal radius
            const sampleOffsets = [0, -0.3, 0.3];
            for (let ox of sampleOffsets) {
                for (let oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.01); // block directly under feet

                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;

                    const blockTop = by + 1; // world Y of the top of that block
                    const gap = blockTop - feetY; // positive if block top is above feet

                    // Consider on ground only if feet are very close to block top
                    if (gap >= -0.02 && gap <= 0.25) {
                        this.onGround = true;
                        break;
                    }
                }
                if (this.onGround) break;
            }
        }

        if (this.onGround) {
            this.usedDoubleJump = false;
        }

        // Limit fall speed (not in fly mode)
        if (!this.flyMode) {
            this.velocity.y = Math.max(this.velocity.y, -0.5);

            // Prevent moving into ground
            if (this.onGround && this.velocity.y < 0) {
                this.velocity.y = 0;
            }
        }

        // Rune of the Batter: mid-air Shift triggers a fast ground pound.
        const shiftPressed = !!(this.keys['shift']);
        const hasBatterRune = this.hasAccessoryEquipped(51);
        const batterCost = 2;
        if (!this.flyMode && hasBatterRune && !this.onGround && shiftPressed && !this.groundPoundUsedThisAir) {
            if (this.spendAP(batterCost)) {
                this.groundPoundActive = true;
                this.groundPoundUsedThisAir = true;
                this.velocity.y = Math.min(this.velocity.y, -0.9);
            }
        }

        if (this.groundPoundActive) {
            if (!this.onGround) {
                // Keep forcing strong downward momentum while slamming.
                this.velocity.y = Math.min(this.velocity.y - 0.05, -1.0);
            } else {
                this.groundPoundActive = false;
            }
        }

        // Emit one impact event when a ground pound lands.
        if (wasGroundPoundActive && this.onGround) {
            this.groundPoundImpactPending = true;
            this.groundPoundActive = false;
        }

        if (this.onGround) {
            this.groundPoundUsedThisAir = false;
        }
    }

    resolveCollisions(world) {
        // AABB collision with axis-aligned sliding
        const halfX = this.size.x / 2;
        const halfZ = this.size.z / 2;
        const halfY = this.size.y / 2;

        const closedDoorBoxes = Array.isArray(world.closedDoorCollisionBoxes) ? world.closedDoorCollisionBoxes : [];
        const pointHitsClosedDoor = (x, y, z) => {
            for (const b of closedDoorBoxes) {
                if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ) {
                    return true;
                }
            }
            return false;
        };

        // Check 8 corners of bounding box
        const checkCollision = (pos) => {
            const blockSolid = world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
            if (blockSolid) return true;
            return pointHitsClosedDoor(pos[0], pos[1], pos[2]);
        };

        const getCorners = (position) => [
            [position.x - halfX, position.y - halfY, position.z - halfZ],
            [position.x + halfX, position.y - halfY, position.z - halfZ],
            [position.x - halfX, position.y + halfY, position.z - halfZ],
            [position.x + halfX, position.y + halfY, position.z - halfZ],
            [position.x - halfX, position.y - halfY, position.z + halfZ],
            [position.x + halfX, position.y - halfY, position.z + halfZ],
            [position.x - halfX, position.y + halfY, position.z + halfZ],
            [position.x + halfX, position.y + halfY, position.z + halfZ],
        ];

        // Check if any corner is colliding
        const hasCollision = (pos) => {
            const corners = getCorners(pos);
            for (const corner of corners) {
                if (checkCollision(corner)) {
                    return true;
                }
            }
            return false;
        };

        // Try to slide along blocks by testing each axis separately
        const testPos = this.position.clone();
        
        // Try X movement
        testPos.x = this.position.x + this.velocity.x;
        if (!hasCollision(testPos)) {
            this.position.x = testPos.x;
        } else {
            // X blocked - try auto-step up if there's a one-block step
            const stepHeight = 0.6; // Max auto-step height
            let stepped = false;
            for (let stepUp = 0.1; stepUp <= stepHeight; stepUp += 0.1) {
                testPos.y = this.position.y + stepUp;
                testPos.x = this.position.x + this.velocity.x;
                if (!hasCollision(testPos)) {
                    // Can step up - check headroom
                    const headPos = testPos.clone();
                    headPos.y += halfY;
                    if (!hasCollision(headPos)) {
                        this.position.x = testPos.x;
                        this.position.y = testPos.y;
                        stepped = true;
                        break;
                    }
                }
            }
            if (!stepped) {
                this.velocity.x = 0;
            }
        }

        // Try Z movement
        testPos.z = this.position.z + this.velocity.z;
        testPos.x = this.position.x; // use updated X position
        if (!hasCollision(testPos)) {
            this.position.z = testPos.z;
        } else {
            // Z blocked - try auto-step up if there's a one-block step
            const stepHeight = 0.6;
            let stepped = false;
            for (let stepUp = 0.1; stepUp <= stepHeight; stepUp += 0.1) {
                testPos.y = this.position.y + stepUp;
                testPos.z = this.position.z + this.velocity.z;
                if (!hasCollision(testPos)) {
                    // Can step up - check headroom
                    const headPos = testPos.clone();
                    headPos.y += halfY;
                    if (!hasCollision(headPos)) {
                        this.position.z = testPos.z;
                        this.position.y = testPos.y;
                        stepped = true;
                        break;
                    }
                }
            }
            if (!stepped) {
                this.velocity.z = 0;
            }
        }

        // Try Y movement (vertical)
        testPos.y = this.position.y + this.velocity.y;
        if (!hasCollision(testPos)) {
            this.position.y = testPos.y;
        } else {
            // Y blocked, handle landing/snapping
            if (this.velocity.y < 0) {
                // falling: snap to top of the highest block under player
                const halfY = this.size.y / 2;
                const feetY = this.position.y - halfY + this.velocity.y; // candidate feet after movement

                // find the highest solid block under player's x/z near feet
                const sampleOffsets = [0, -0.3, 0.3];
                let highestTop = -Infinity;
                for (let ox of sampleOffsets) {
                    for (let oz of sampleOffsets) {
                        const bx = Math.floor(this.position.x + ox);
                        const bz = Math.floor(this.position.z + oz);
                        const by = Math.floor(feetY - 0.01);
                        if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                            const top = by + 1;
                            if (top > highestTop) highestTop = top;
                        }
                    }
                }
                if (highestTop !== -Infinity) {
                    // place player's center so feet sit slightly above block top
                    this.position.y = highestTop + halfY + 0.001;
                }
            }

            // stop vertical movement in all cases
            this.velocity.y = 0;
        }
    }

    // Simple check whether there is a solid block directly in front of the player
    isForwardBlocked(world) {
        const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        // check slightly ahead of player's center (half width + small epsilon)
        const checkDist = this.size.x / 2 + 0.15;
        const probe = this.position.clone().addScaledVector(forward, checkDist);

        // check around player's vertical center and feet
        const ys = [0, -this.size.y / 4, this.size.y / 4];
        for (const dy of ys) {
            const x = Math.floor(probe.x);
            const y = Math.floor(probe.y + dy);
            const z = Math.floor(probe.z);
            if (world.isBlockSolid(world.getBlock(x, y, z))) return true;
        }
        return false;
    }

    jump(world) {
        const getJumpPowerWithEnchant = () => {
            let jumpMul = 1;
            const legs = this.equipment.legs;
            if (legs && typeof legs === 'object' && legs.jumpBonus) {
                jumpMul += legs.jumpBonus / 100;
            }
            return this.jumpPower * jumpMul;
        };

        const hasBootDoubleJump = () => {
            const boots = this.equipment.boots;
            return !!(boots && typeof boots === 'object' && boots.doubleJump);
        };

        const jumpPowerNow = getJumpPowerWithEnchant();

        if (this.onGround) {
            this.velocity.y = jumpPowerNow;
            this.onGround = false;
            this.usedDoubleJump = false;
            return;
        }

        // Cloutump enchant: one extra jump while airborne.
        if (!this.flyMode && hasBootDoubleJump() && !this.usedDoubleJump) {
            this.velocity.y = jumpPowerNow;
            this.usedDoubleJump = true;
            return;
        }

        if (!world) return;

        // Allow jump when hugging a wall: if forward is blocked but there is space above and a step below
        if (this.isForwardBlocked(world)) {
            const halfY = this.size.y / 2;
            const feetY = this.position.y - halfY;
            const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
            const probe = this.position.clone().addScaledVector(forward, this.size.x / 2 + 0.15);

            const bx = Math.floor(probe.x);
            const bz = Math.floor(probe.z);
            const byFeet = Math.floor(feetY - 0.05);
            const byHead = Math.floor(this.position.y + halfY + 0.1);

            const baseBlock = world.getBlock(bx, byFeet, bz);
            const aboveBlock = world.getBlock(bx, byFeet + 1, bz);
            const headClear = !world.isBlockSolid(world.getBlock(bx, byHead, bz));

            // If there's a one-block step ahead with headroom, allow jump
            if (world.isBlockSolid(baseBlock) && !world.isBlockSolid(aboveBlock) && headClear) {
                this.velocity.y = jumpPowerNow;
                this.onGround = false;
                return;
            }
        }

        // Allow jump if player is very close above a block (tolerance for hugging walls)
        const halfY = this.size.y / 2;
        const feetY = this.position.y - halfY;
        const sampleOffsets = [0, -0.3, 0.3];
        for (let ox of sampleOffsets) {
            for (let oz of sampleOffsets) {
                const bx = Math.floor(this.position.x + ox);
                const bz = Math.floor(this.position.z + oz);
                const by = Math.floor(feetY - 0.01);

                const block = world.getBlock(bx, by, bz);
                if (!block) continue;
                if (!world.isBlockSolid(block)) continue;

                const blockTop = by + 1;
                const gap = blockTop - feetY;
                // If feet are within a small tolerance above the block, snap and allow jump
                if (gap >= -0.05 && gap <= 0.35) {
                    // snap player up so feet sit just above block
                    this.position.y = blockTop + halfY + 0.001;
                    this.velocity.y = jumpPowerNow;
                    this.onGround = false;
                    return;
                }
            }
        }
    }

    getAttackDamage() {
        // Calculate attack damage based on equipped weapon in mainHand
        const equipped = this.equipment.mainHand;
        let baseDamage = 1; // Default fist damage
        let damageBonus = 0;
        
        // Get base damage by sword type
        if (equipped && typeof equipped === 'object') {
            if (equipped.type === 22) {
                baseDamage = 4; // Stone Sword damage
            } else if (equipped.type === 32) {
                baseDamage = 6; // Golden Sword damage
            }
            // Apply damage bonus from scrolls
            if (equipped.damageBonus) {
                damageBonus = equipped.damageBonus;
            }
        } else if (equipped === 22) {
            // Handle legacy numeric format
            baseDamage = 4;
        } else if (equipped === 32) {
            baseDamage = 6;
        }
        
        // Apply damage bonus as percentage
        const totalDamage = baseDamage * (1 + damageBonus / 100);
        return totalDamage;
    }

    getArmorReduction() {
        // Calculate total armor damage reduction from equipped items
        // Each leather armor piece provides 5% reduction
        let armorPercent = 0;
        
        // Check each armor slot
        const armorPieces = {
            head: 18,    // Leather Helmet
            body: 19,    // Leather Chestplate
            legs: 20,    // Leather Leggings
            boots: 21    // Leather Boots
        };
        
        for (const [slot, armorType] of Object.entries(armorPieces)) {
            const equipped = this.equipment[slot];
            if (equipped && typeof equipped === 'object') {
                if (equipped.type === armorType) {
                    armorPercent += 5; // 5% per piece
                }
                if (equipped.armorBonus) {
                    armorPercent += equipped.armorBonus; // Enchantment bonus
                }
            } else if (equipped === armorType) {
                // Handle legacy numeric format
                armorPercent += 5;
            }
        }
        
        return Math.min(armorPercent, 100); // Cap at 100%
    }

    getCamera() {
        const fov = parseFloat(localStorage.getItem('fov')) || 90;
        const camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.copy(this.position);
        camera.position.y += 1.3; // Eye height tuned for 1.5m tall collider

        const cameraBobEnabled = localStorage.getItem('cameraBobEnabled');
        const bobOn = (cameraBobEnabled === null) ? true : cameraBobEnabled !== 'false';
        if (bobOn) {
            const bobStrength = this.isSprinting ? 0.09 : 0.03;
            const bobY = Math.sin(this.bobPhase) * bobStrength * this.bobAmount;
            const bobX = Math.cos(this.bobPhase * 0.55) * (bobStrength * 0.7) * this.bobAmount;
            camera.position.y += bobY;
            camera.position.x += bobX;
        }

        const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
        camera.quaternion.setFromEuler(euler);
        return camera;
    }

    takeDamage(amount, attacker = null) {
        if (!this.survivalMode || this.isDead) return;
        
        const now = performance.now ? performance.now() : Date.now();
        // Invulnerability period (0.5s)
        if (now < this.invulnerableUntil) return;
        
        // Check for wood shield reflection (3% chance)
        const offHandItem = this.equipment.offHand;
        const hasWoodShield = (offHandItem && typeof offHandItem === 'object' && offHandItem.type === 23) || offHandItem === 23;
        
        if (hasWoodShield && attacker && Math.random() < 0.03) {
            // Reflect damage back to attacker
            if (attacker.takeDamage) {
                attacker.takeDamage(amount, null); // Reflect original damage, no chain reflection
                console.log(`Wood Shield reflected ${amount} damage back to attacker!`);
            }
            return; // Don't take damage if reflected
        }
        
        // Apply armor damage reduction
        const armorReduction = this.getArmorReduction();
        const damageMultiplier = 1 - (armorReduction / 100);
        const actualDamage = amount * damageMultiplier;
        
        this.health = Math.max(0, this.health - actualDamage);
        this.invulnerableUntil = now + 500; // 500ms invulnerability
        
        // Check if attacker has a curse weapon
        if (attacker && attacker.equipment && attacker.equipment.mainHand) {
            const weaponItem = attacker.equipment.mainHand;
            if (weaponItem && typeof weaponItem === 'object' && weaponItem.hasCurse && weaponItem.curseType === 'gloom') {
                // Apply blindness curse if this is the game instance
                if (this.gameInstance && this.gameInstance.applyBlindness) {
                    this.gameInstance.applyBlindness();
                }
            }
        }
        
        if (armorReduction > 0) {
            console.log(`Player took ${actualDamage.toFixed(1)} damage (${amount} reduced by ${armorReduction}% armor)! Health: ${this.health}/${this.maxHealth}`);
        } else {
            console.log(`Player took ${actualDamage} damage! Health: ${this.health}/${this.maxHealth}`);
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            console.log('Player died!');
        }
    }
}

class piggron {
    constructor(position = new THREE.Vector3(), survivalMode = false, piggronTexture = null, gameInstance = null) {
        this.position = position.clone();
        this.game = gameInstance; // Store game reference for model access
        this.yaw = 0;
        this.speed = 0.08; // Chase speed
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.3, halfY: 0.7, halfZ: 0.3 };
        this.onGround = false;
        this.jumpPower = 0.25;
        this.jumpCooldown = 350; // ms
        this.lastJumpTime = 0;
        this.mesh = null;
        this.piggronTexture = piggronTexture; // Store texture reference
        
        // Survival mode
        this.survivalMode = survivalMode;
        this.maxHealth = 15;
        this.health = 15;
        this.isDead = false;
        this.attackDamage = 2;
        this.attackCooldown = 1000; // ms between attacks
        this.lastAttackTime = 0;
        this.isAggressive = false; // Only attack if player hits them first
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.03;
        
        // Damage flash effect
        this.damageFlashUntil = 0;
        this.originalMaterials = [];
    }

    createMesh() {
        // Try to use the loaded 3D model if available
        if (this.game && this.game.piggronModelTemplate) {
            console.log('[piggron] Using 3D model for piggron');
            const group = this.game.piggronModelTemplate.clone();
            group.position.copy(this.position);
            this.mesh = group;
            
            // Store materials for damage flash effect
            this.originalMaterials = [];
            group.traverse(child => {
                if (child.isMesh) {
                    this.originalMaterials.push({
                        mesh: child,
                        material: child.material
                    });
                }
            });
            
            return group;
        }
        
        console.log('[piggron] 3D model not available yet, using fallback. game:', !!this.game, 'template:', this.game ? !!this.game.piggronModelTemplate : 'N/A');

        // Fallback to box geometry if model not loaded
        const group = new THREE.Group();

        // Use piggron texture if available, otherwise use solid colors
        const skin = this.piggronTexture ? 
            new THREE.MeshLambertMaterial({ map: this.piggronTexture }) :
            new THREE.MeshLambertMaterial({ color: 0xd28a7c });
        const cloth = new THREE.MeshLambertMaterial({ color: 0x444444 });

        // Torso
        const torsoGeo = new THREE.BoxGeometry(0.7, 0.9, 0.4);
        const torso = new THREE.Mesh(torsoGeo, skin);
        torso.castShadow = true;
        group.add(torso);

        // Head
        const headGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
        const head = new THREE.Mesh(headGeo, skin);
        head.position.y = 0.9;
        head.castShadow = true;
        group.add(head);

        // Legs
        const legGeo = new THREE.BoxGeometry(0.25, 0.6, 0.25);
        const legOffsets = [-0.18, 0.18];
        legOffsets.forEach(x => {
            const leg = new THREE.Mesh(legGeo, cloth);
            leg.position.set(x, -0.75, 0);
            leg.castShadow = true;
            group.add(leg);
        });

        // Arms
        const armGeo = new THREE.BoxGeometry(0.2, 0.55, 0.2);
        const armOffsets = [-0.5, 0.5];
        armOffsets.forEach(x => {
            const arm = new THREE.Mesh(armGeo, skin);
            arm.position.set(x, 0.1, 0);
            arm.castShadow = true;
            group.add(arm);
        });

        // Eyes - white eyes with black dots
        const eyeWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const eyeBlack = new THREE.MeshBasicMaterial({ color: 0x000000 });
        
        // Left eye white
        const eyeGeo = new THREE.SphereGeometry(0.10, 8, 8);
        const leftEye = new THREE.Mesh(eyeGeo, eyeWhite);
        leftEye.position.set(-0.12, 1.05, 0.28);
        leftEye.castShadow = false;
        group.add(leftEye);
        
        // Left pupil (black dot)
        const leftPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        leftPupil.position.set(-0.12, 1.05, 0.33);
        leftPupil.castShadow = false;
        group.add(leftPupil);
        
        // Right eye white
        const rightEye = new THREE.Mesh(eyeGeo, eyeWhite);
        rightEye.position.set(0.12, 1.05, 0.28);
        rightEye.castShadow = false;
        group.add(rightEye);
        
        // Right pupil (black dot)
        const rightPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        rightPupil.position.set(0.12, 1.05, 0.33);
        rightPupil.castShadow = false;
        group.add(rightPupil);

        // Snout (small cone protruding from face)
        const snoutGeo = new THREE.ConeGeometry(0.1, 0.15, 8);
        const snout = new THREE.Mesh(snoutGeo, skin);
        snout.position.set(0, 0.8, 0.35);
        snout.rotation.x = -Math.PI / 2; // Point forward
        snout.castShadow = false;
        group.add(snout);

        group.position.copy(this.position);
        this.mesh = group;

        // Store original materials for damage flash
        this.originalMaterials = [];
        group.traverse(child => {
            if (child.isMesh) {
                this.originalMaterials.push({
                    mesh: child,
                    material: child.material
                });
            }
        });

        return group;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const debugStart = performance.now();
        const now = performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.25, 0.25];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        // Keep grounded state stable before applying gravity
        this.onGround = checkGround();

        // Apply gravity
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        const nowMove = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        // Movement: wander when passive, chase when aggressive
        let horizontal = new THREE.Vector3();
        if (this.isAggressive) {
            const toPlayer = targetPlayer.position.clone().sub(this.position);
            horizontal.set(toPlayer.x, 0, toPlayer.z);
        } else {
            // Refresh wander direction occasionally
            if (nowMove >= this.nextWanderChange) {
                const wanderStart = performance.now();
                const pause = Math.random() < 0.25;
                if (pause) {
                    this.wanderDir = new THREE.Vector3(0, 0, 0);
                } else {
                    const angle = Math.random() * Math.PI * 2;
                    this.wanderDir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
                }
                this.nextWanderChange = nowMove + 1500 + Math.random() * 2000;
                const wanderElapsed = performance.now() - wanderStart;
                if (wanderElapsed > 10) console.log(`[PERF] piggron wander change took ${wanderElapsed.toFixed(2)}ms`);
            }
            horizontal.copy(this.wanderDir);
        }

        const distance = horizontal.length();
        if (distance > 0.05) {
            horizontal.normalize();
            const moveSpeed = this.isAggressive ? this.speed : this.wanderSpeed;
            const step = moveSpeed * Math.max(deltaTime * 60, 1); // scale for frame time
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.6;
            this.velocity.z *= 0.6;
        }

        // Attempt a small hop over single-block obstacles while moving
        if (this.onGround && distance > 0.05) {
            const forward = horizontal.lengthSq() > 0 ? horizontal.clone().normalize() : null;
            if (forward) {
                const probeX = this.position.x + forward.x * (halfX + 0.25);
                const probeZ = this.position.z + forward.z * (halfZ + 0.25);
                const footY = Math.floor(this.position.y - halfY - 0.01);
                const headY = Math.floor(this.position.y + halfY + 0.2);
                const baseBlock = world.getBlock(Math.floor(probeX), footY, Math.floor(probeZ));
                const aboveBlock = world.getBlock(Math.floor(probeX), footY + 1, Math.floor(probeZ));
                const headClear = !world.isBlockSolid(world.getBlock(Math.floor(probeX), headY, Math.floor(probeZ)));

                if (world.isBlockSolid(baseBlock) && !world.isBlockSolid(aboveBlock) && headClear) {
                    if (nowMove - this.lastJumpTime >= this.jumpCooldown) {
                        this.velocity.y = this.jumpPower;
                        this.onGround = false;
                        this.lastJumpTime = nowMove;
                    }
                }
            }
        }

        // Simple collision helper
        const isSolidAt = (pos) => world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        const hasCollision = (pos) => {
            const pts = [
                [pos.x - halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z + halfZ]
            ];
            for (const p of pts) if (isSolidAt(p)) return true;
            return false;
        };

        const nextPos = this.position.clone();
        // Horizontal X
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }

        // Horizontal Z
        nextPos.z = this.position.z + this.velocity.z;
        nextPos.x = this.position.x; // reset X to accepted value
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }

        // Vertical
        nextPos.y = this.position.y + this.velocity.y;
        nextPos.x = this.position.x;
        nextPos.z = this.position.z;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            // If falling onto ground, snap to top of block
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }

        // Refresh grounded state after movement to keep gravity/jumps stable
        this.onGround = landed || checkGround();

        // Attack player only if aggressive (i.e., player hit them first)
        if (this.survivalMode && this.isAggressive && targetPlayer && !targetPlayer.isDead) {
            const dist = this.position.distanceTo(targetPlayer.position);
            if (dist < 2.0) { // Attack range
                if (now - this.lastAttackTime >= this.attackCooldown) {
                    targetPlayer.takeDamage(this.attackDamage, this);
                    this.lastAttackTime = now;
                }
            }
        }

        // Idle bobbing visual only when on ground
        const t = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bob = this.onGround ? Math.sin(t * 4) * 0.05 : 0;

        // Update damage flash effect using emissive, not new materials
        if (now < this.damageFlashUntil) {
            // Flash red using emissive
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0xff0000);
                        child.material.emissiveIntensity = 0.8;
                    }
                });
            }
            
        } else if (this.damageFlashUntil > 0) {
            // Restore original emissive
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0x000000);
                        child.material.emissiveIntensity = 0;
                    }
                });
            }
            this.damageFlashUntil = 0;
        }

        if (this.mesh) {
            this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);
            this.mesh.rotation.y = this.yaw;
        }
        
        const totalElapsed = performance.now() - debugStart;
        if (totalElapsed > 20) {
            console.warn(`[PERF] piggron.update() took ${totalElapsed.toFixed(2)}ms`);
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;
        
        this.health = Math.max(0, this.health - amount);
        this.isAggressive = true; // Become aggressive when hit
        console.log(`piggron took ${amount} damage! Health: ${this.health}/${this.maxHealth}`);
        
        // Apply red flash effect for 200ms
        const now = performance.now ? performance.now() : Date.now();
        this.damageFlashUntil = now + 200;
        
        // Apply knockback
        if (knockbackDir) {
            const knockbackStrength = 0.3;
            this.velocity.x = knockbackDir.x * knockbackStrength;
            this.velocity.z = knockbackDir.z * knockbackStrength;
            this.velocity.y = 0.15; // Small upward boost
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            try {
                const deathSfx = new Audio('Pig sound effect.mp3');
                deathSfx.volume = 0.8;
                deathSfx.play().catch(() => {});
            } catch (e) {}
            console.log('piggron died!');
            return true; // Died
        }

        try {
            const hurtSfx = new Audio('Pig Grunt and Squeal Sound Effect.mp3');
            hurtSfx.volume = 0.75;
            hurtSfx.play().catch(() => {});
        } catch (e) {}

        return false; // Still alive
    }
}

class piggronPriest {
    constructor(position = new THREE.Vector3(), survivalMode = false) {
        this.position = position.clone();
        this.yaw = 0;
        this.speed = 0.06; // Slower than regular piggron
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.4, halfY: 0.9, halfZ: 0.4 }; // Larger
        this.onGround = false;
        this.jumpPower = 0.3;
        this.jumpCooldown = 350;
        this.lastJumpTime = 0;
        this.mesh = null;
        
        // Boss stats
        this.survivalMode = survivalMode;
        this.maxHealth = 100; // Much tankier
        this.health = 100;
        this.isDead = false;
        this.attackDamage = 5; // Heavy damage
        this.attackCooldown = 1500;
        this.lastAttackTime = 0;
        this.isAggressive = true; // Always aggressive
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.02;
        
        // Special abilities
        this.healCooldown = 8000; // Heal every 8 seconds
        this.lastHealTime = 0;
        this.healAmount = 10;
        
        this.damageFlashUntil = 0;
        this.originalMaterials = [];
    }

    createMesh() {
        const group = new THREE.Group();

        // Golden/priest colors
        const skin = new THREE.MeshLambertMaterial({ 
            color: 0xd28a7c,
            emissive: new THREE.Color(0x442200),
            emissiveIntensity: 0.3
        });
        const robes = new THREE.MeshLambertMaterial({ 
            color: 0x8B0000, // Dark red robes
            emissive: new THREE.Color(0x330000),
            emissiveIntensity: 0.4
        });
        const gold = new THREE.MeshLambertMaterial({ 
            color: 0xFFD700,
            emissive: new THREE.Color(0xFFAA00),
            emissiveIntensity: 0.6
        });

        // Larger torso
        const torsoGeo = new THREE.BoxGeometry(0.9, 1.2, 0.5);
        const torso = new THREE.Mesh(torsoGeo, robes);
        torso.castShadow = true;
        group.add(torso);

        // Larger head with crown
        const headGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
        const head = new THREE.Mesh(headGeo, skin);
        head.position.y = 1.2;
        head.castShadow = true;
        group.add(head);

        // Crown
        const crownGeo = new THREE.BoxGeometry(0.75, 0.2, 0.75);
        const crown = new THREE.Mesh(crownGeo, gold);
        crown.position.y = 1.55;
        crown.castShadow = true;
        group.add(crown);

        // Legs
        const legGeo = new THREE.BoxGeometry(0.3, 0.7, 0.3);
        const legOffsets = [-0.25, 0.25];
        legOffsets.forEach(x => {
            const leg = new THREE.Mesh(legGeo, robes);
            leg.position.set(x, -0.95, 0);
            leg.castShadow = true;
            group.add(leg);
        });

        // Arms
        const armGeo = new THREE.BoxGeometry(0.25, 0.7, 0.25);
        const armOffsets = [-0.6, 0.6];
        armOffsets.forEach(x => {
            const arm = new THREE.Mesh(armGeo, skin);
            arm.position.set(x, 0.2, 0);
            arm.castShadow = true;
            group.add(arm);
        });

        // Staff
        const staffGeo = new THREE.BoxGeometry(0.1, 1.5, 0.1);
        const staff = new THREE.Mesh(staffGeo, gold);
        staff.position.set(-0.7, 0.5, 0);
        staff.castShadow = true;
        group.add(staff);

        // Eyes
        const eyeWhite = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const eyeBlack = new THREE.MeshLambertMaterial({ color: 0x000000 });
        
        // Left eye
        const eyeGeo = new THREE.SphereGeometry(0.1, 8, 8);
        const leftEye = new THREE.Mesh(eyeGeo, eyeWhite);
        leftEye.position.set(-0.18, 1.45, 0.25);
        leftEye.castShadow = true;
        group.add(leftEye);
        
        const leftPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        leftPupil.position.set(-0.18, 1.45, 0.32);
        leftPupil.castShadow = true;
        group.add(leftPupil);
        
        // Right eye
        const rightEye = new THREE.Mesh(eyeGeo, eyeWhite);
        rightEye.position.set(0.18, 1.45, 0.25);
        rightEye.castShadow = true;
        group.add(rightEye);
        
        const rightPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        rightPupil.position.set(0.18, 1.45, 0.32);
        rightPupil.castShadow = true;
        group.add(rightPupil);

        // Add snout
        const snoutGeo = new THREE.ConeGeometry(0.1, 0.15, 8);
        const snout = new THREE.Mesh(snoutGeo, skin);
        snout.position.set(0, 1.0, 0.4);
        snout.rotation.x = -Math.PI / 2;
        snout.castShadow = true;
        group.add(snout);

        group.position.copy(this.position);
        this.mesh = group;
        
        this.originalMaterials = [];
        group.traverse(child => {
            if (child.isMesh) {
                this.originalMaterials.push({
                    mesh: child,
                    material: child.material
                });
            }
        });
        
        return this.mesh;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const now = performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.3, 0.3];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        this.onGround = checkGround();

        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        // Always chase player (boss is always aggressive)
        const toPlayer = targetPlayer.position.clone().sub(this.position);
        const horizontal = new THREE.Vector3(toPlayer.x, 0, toPlayer.z);
        const distance = horizontal.length();

        if (distance > 0.5) {
            horizontal.normalize();
            const step = this.speed * Math.max(deltaTime * 60, 1);
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.6;
            this.velocity.z *= 0.6;
        }

        // Heal ability
        if (this.health < this.maxHealth && now - this.lastHealTime >= this.healCooldown) {
            this.health = Math.min(this.maxHealth, this.health + this.healAmount);
            this.lastHealTime = now;
            console.log(`piggron Priest healed! Health: ${this.health}/${this.maxHealth}`);
        }

        // Simple collision
        const isSolidAt = (pos) => world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        const hasCollision = (pos) => {
            const pts = [
                [pos.x - halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z + halfZ]
            ];
            for (const p of pts) if (isSolidAt(p)) return true;
            return false;
        };

        const nextPos = this.position.clone();
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }

        nextPos.z = this.position.z + this.velocity.z;
        nextPos.x = this.position.x;
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }

        nextPos.y = this.position.y + this.velocity.y;
        nextPos.x = this.position.x;
        nextPos.z = this.position.z;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }

        this.onGround = landed || checkGround();

        // Attack player
        if (this.survivalMode && targetPlayer && !targetPlayer.isDead) {
            const dist = this.position.distanceTo(targetPlayer.position);
            if (dist < 2.5) {
                if (now - this.lastAttackTime >= this.attackCooldown) {
                    targetPlayer.takeDamage(this.attackDamage, this);
                    this.lastAttackTime = now;
                    console.log('piggron Priest attacked!');
                }
            }
        }

        const t = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bob = this.onGround ? Math.sin(t * 3) * 0.08 : 0;

        // Damage flash
        if (now < this.damageFlashUntil) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0xff0000);
                        child.material.emissiveIntensity = 1.0;
                    }
                });
            }
        } else if (this.damageFlashUntil > 0) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        // Restore original emissive (golden glow)
                        if (child.material.color.getHex() === 0xFFD700) {
                            child.material.emissive.setHex(0xFFAA00);
                            child.material.emissiveIntensity = 0.6;
                        } else {
                            child.material.emissive.setHex(0x000000);
                            child.material.emissiveIntensity = 0;
                        }
                    }
                });
            }
            this.damageFlashUntil = 0;
        }

        if (this.mesh) {
            this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);
            this.mesh.rotation.y = this.yaw;
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;
        
        this.health = Math.max(0, this.health - amount);
        console.log(`piggron Priest took ${amount} damage! Health: ${this.health}/${this.maxHealth}`);
        
        const now = performance.now ? performance.now() : Date.now();
        this.damageFlashUntil = now + 200;
        
        if (knockbackDir) {
            const knockbackStrength = 0.2; // Boss is heavier, less knockback
            this.velocity.x = knockbackDir.x * knockbackStrength;
            this.velocity.z = knockbackDir.z * knockbackStrength;
            this.velocity.y = 0.1;
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            console.log('piggron Priest defeated!');
            return true;
        }
        return false;
    }
}


// Simple teal slime creature with grey eyes
class Slime {
    constructor(position = new THREE.Vector3(), survivalMode = false, gameInstance = null) {
        this.position = position.clone();
        this.game = gameInstance;
        this.yaw = 0;
        this.speed = 0.05; // slow
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.01;
        this.size = { halfX: 0.4, halfY: 0.4, halfZ: 0.4 };
        this.onGround = false;
        this.jumpPower = 0.25;
        this.jumpCooldown = 1000;
        this.lastJumpTime = 0;
        this.mesh = null;
        
        // Survival mode
        this.survivalMode = survivalMode;
        this.maxHealth = 8;
        this.health = 8;
        this.isDead = false;
        this.attackDamage = 0; // passive
        this.attackCooldown = 1000;
        this.lastAttackTime = 0;
        this.isAggressive = false;
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.02;
        
        // Damage flash
        this.damageFlashUntil = 0;
    }

    createMesh() {
        const group = new THREE.Group();

        const bodyMat = new THREE.MeshLambertMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.5
        });
        const eyeMat = new THREE.MeshLambertMaterial({ color: 0x888888 });

        const bodyGeo = new THREE.SphereGeometry(0.4, 16, 16);
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.castShadow = true;
        group.add(body);

        const eyeGeo = new THREE.SphereGeometry(0.1, 8, 8);
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.15, 0.1, 0.36);
        leftEye.castShadow = true;
        group.add(leftEye);

        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.15, 0.1, 0.36);
        rightEye.castShadow = true;
        group.add(rightEye);

        group.position.copy(this.position);
        this.mesh = group;
        return group;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world) return;
        const now = performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.25, 0.25];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        this.onGround = checkGround();
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        // Wander direction update
        if (now >= this.nextWanderChange) {
            if (Math.random() < 0.3) {
                this.wanderDir.set(0, 0, 0);
            } else {
                const angle = Math.random() * Math.PI * 2;
                this.wanderDir.set(Math.sin(angle), 0, Math.cos(angle));
            }
            this.nextWanderChange = now + 2000 + Math.random() * 2000;
        }

        const dist = this.wanderDir.length();
        if (dist > 0.05) {
            this.wanderDir.normalize();
            const step = this.wanderSpeed * Math.max(deltaTime * 60, 1);
            this.velocity.x = this.wanderDir.x * step;
            this.velocity.z = this.wanderDir.z * step;
            this.yaw = Math.atan2(this.wanderDir.x, this.wanderDir.z);
        } else {
            this.velocity.x *= 0.6;
            this.velocity.z *= 0.6;
        }

        // Simple hop over obstacles
        if (this.onGround && dist > 0.05) {
            const lookX = Math.sin(this.yaw) * 0.6;
            const lookZ = Math.cos(this.yaw) * 0.6;
            const feetY = this.position.y - halfY;
            const floorY = Math.floor(feetY);
            const bx = Math.floor(this.position.x + lookX);
            const bz = Math.floor(this.position.z + lookZ);
            const blockInFront = world.getBlock(bx, floorY, bz);
            const blockAbove = world.getBlock(bx, floorY + 1, bz);
            if (world.isBlockSolid(blockInFront) && !world.isBlockSolid(blockAbove)) {
                if (now - this.lastJumpTime >= this.jumpCooldown) {
                    this.velocity.y = this.jumpPower;
                    this.lastJumpTime = now;
                }
            }
        }

        // Collision helper
        const isSolidAt = (pos) => world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        const hasCollision = (pos) => {
            const pts = [
                [pos.x - halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z + halfZ]
            ];
            for (const p of pts) if (isSolidAt(p)) return true;
            return false;
        };

        let nextPos = this.position.clone();
        // X
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }
        // Z
        nextPos.z = this.position.z + this.velocity.z;
        nextPos.x = this.position.x;
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }
        // Y
        nextPos.y = this.position.y + this.velocity.y;
        nextPos.x = this.position.x;
        nextPos.z = this.position.z;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }
        this.onGround = landed || checkGround();

        // Damage flash
        if (now < this.damageFlashUntil && this.mesh) {
            this.mesh.traverse(child => {
                if (child.isMesh && child.material) {
                    child.material.emissive.setHex(0xff0000);
                    child.material.emissiveIntensity = 0.8;
                }
            });
        } else if (this.damageFlashUntil > 0) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0x000000);
                        child.material.emissiveIntensity = 0;
                    }
                });
            }
            this.damageFlashUntil = 0;
        }

        if (this.mesh) {
            this.mesh.position.set(this.position.x, this.position.y, this.position.z);
            this.mesh.rotation.y = this.yaw;
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;
        this.health = Math.max(0, this.health - amount);
        const now = performance.now ? performance.now() : Date.now();
        this.damageFlashUntil = now + 200;
        if (knockbackDir) {
            const kb = 0.2;
            this.velocity.x = knockbackDir.x * kb;
            this.velocity.z = knockbackDir.z * kb;
            this.velocity.y = 0.15;
        }
        if (this.health <= 0) {
            this.isDead = true;
            // drop slime item
            if (this.game && this.game.itemManager) {
                const dropPos = this.position.clone();
                dropPos.y += 0.5;
                this.game.itemManager.dropItem(dropPos, this.game.SLIME_TYPE, 1);
            }
            return true;
        }
        return false;
    }
}

class Squirrel {
    constructor(position = new THREE.Vector3(), gameInstance = null) {
        this.position = position.clone();
        this.game = gameInstance;
        this.yaw = 0;
        this.speed = 0.12; // Nimble and quick
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.125, halfY: 0.2, halfZ: 0.1 }; // Very small creature
        this.onGround = false;
        this.jumpPower = 0.22;
        this.jumpCooldown = 400; // ms
        this.lastJumpTime = 0;
        this.mesh = null;
        
        // Behavior
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.08;
    }

    createMesh() {
        const group = new THREE.Group();

        // Main body - reddish-brown
        const bodyMaterial = new THREE.MeshLambertMaterial({ color: 0xcc6633 });
        const tailMaterial = new THREE.MeshLambertMaterial({ color: 0x996633 });

        // Torso (main body)
        const torsoGeo = new THREE.BoxGeometry(0.25, 0.2, 0.15);
        const torso = new THREE.Mesh(torsoGeo, bodyMaterial);
        torso.castShadow = true;
        group.add(torso);

        // Head
        const headGeo = new THREE.SphereGeometry(0.1, 8, 8);
        const head = new THREE.Mesh(headGeo, bodyMaterial);
        head.position.y = 0.12;
        head.position.z = 0.08;
        head.castShadow = true;
        group.add(head);

        // Ears - triangular
        const earGeo = new THREE.ConeGeometry(0.04, 0.07, 8);
        const leftEar = new THREE.Mesh(earGeo, bodyMaterial);
        leftEar.position.set(-0.08, 0.22, 0.08);
        leftEar.castShadow = true;
        group.add(leftEar);
        
        const rightEar = new THREE.Mesh(earGeo, bodyMaterial);
        rightEar.position.set(0.08, 0.22, 0.08);
        rightEar.castShadow = true;
        group.add(rightEar);

        // Small eyes
        const eyeBlack = new THREE.MeshBasicMaterial({ color: 0x000000 });
        const eyeGeo = new THREE.SphereGeometry(0.02, 8, 8);
        
        const leftEye = new THREE.Mesh(eyeGeo, eyeBlack);
        leftEye.position.set(-0.05, 0.16, 0.18);
        group.add(leftEye);
        
        const rightEye = new THREE.Mesh(eyeGeo, eyeBlack);
        rightEye.position.set(0.05, 0.16, 0.18);
        group.add(rightEye);

        // Bushy tail - large and fluffy
        const tailGeo = new THREE.BoxGeometry(0.08, 0.25, 0.18);
        const tail = new THREE.Mesh(tailGeo, tailMaterial);
        tail.position.set(0, 0.05, -0.2);
        tail.rotation.z = 0.4; // Curved upward
        tail.castShadow = true;
        group.add(tail);

        // Front legs
        const legGeo = new THREE.BoxGeometry(0.06, 0.12, 0.06);
        const frontLeftLeg = new THREE.Mesh(legGeo, bodyMaterial);
        frontLeftLeg.position.set(-0.1, -0.1, 0.05);
        frontLeftLeg.castShadow = true;
        group.add(frontLeftLeg);
        
        const frontRightLeg = new THREE.Mesh(legGeo, bodyMaterial);
        frontRightLeg.position.set(0.1, -0.1, 0.05);
        frontRightLeg.castShadow = true;
        group.add(frontRightLeg);

        // Back legs
        const backLeftLeg = new THREE.Mesh(legGeo, bodyMaterial);
        backLeftLeg.position.set(-0.1, -0.1, -0.05);
        backLeftLeg.castShadow = true;
        group.add(backLeftLeg);
        
        const backRightLeg = new THREE.Mesh(legGeo, bodyMaterial);
        backRightLeg.position.set(0.1, -0.1, -0.05);
        backRightLeg.castShadow = true;
        group.add(backRightLeg);

        group.position.copy(this.position);
        this.mesh = group;
        return group;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        // Check ground collision
        const checkGround = () => {
            const sampleOffsets = [0, -0.1, 0.1];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        this.onGround = checkGround();

        // Apply gravity
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        // Wander behavior - squirrels are curious and constantly moving
        if (now >= this.nextWanderChange) {
            const pause = Math.random() < 0.15; // mostly moving
            if (pause) {
                this.wanderDir = new THREE.Vector3(0, 0, 0);
            } else {
                const angle = Math.random() * Math.PI * 2;
                this.wanderDir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
            }
            this.nextWanderChange = now + 800 + Math.random() * 1200; // Change direction frequently
        }

        let horizontal = this.wanderDir.clone();
        const distance = horizontal.length();
        if (distance > 0.05) {
            horizontal.normalize();
            const step = this.wanderSpeed * Math.max(deltaTime * 60, 1);
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.7;
            this.velocity.z *= 0.7;
        }

        // Squirrels can jump over small obstacles
        if (this.onGround && distance > 0.05) {
            const forward = horizontal.lengthSq() > 0 ? horizontal.clone().normalize() : null;
            if (forward) {
                const probeX = this.position.x + forward.x * (halfX + 0.15);
                const probeZ = this.position.z + forward.z * (halfZ + 0.15);
                const footY = Math.floor(this.position.y - halfY - 0.01);
                const headY = Math.floor(this.position.y + halfY + 0.15);
                const baseBlock = world.getBlock(Math.floor(probeX), footY, Math.floor(probeZ));
                const aboveBlock = world.getBlock(Math.floor(probeX), footY + 1, Math.floor(probeZ));
                const headClear = !world.isBlockSolid(world.getBlock(Math.floor(probeX), headY, Math.floor(probeZ)));

                if (world.isBlockSolid(baseBlock) && !world.isBlockSolid(aboveBlock) && headClear) {
                    if (now - this.lastJumpTime >= this.jumpCooldown) {
                        this.velocity.y = this.jumpPower;
                        this.onGround = false;
                        this.lastJumpTime = now;
                    }
                }
            }
        }

        // Collision detection helper
        const isSolidAt = (pos) => world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        const hasCollision = (pos) => {
            const pts = [
                [pos.x - halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z + halfZ]
            ];
            for (const p of pts) if (isSolidAt(p)) return true;
            return false;
        };

        const nextPos = this.position.clone();
        // Horizontal X
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }

        // Horizontal Z
        nextPos.z = this.position.z + this.velocity.z;
        nextPos.x = this.position.x;
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }

        // Vertical
        nextPos.y = this.position.y + this.velocity.y;
        nextPos.x = this.position.x;
        nextPos.z = this.position.z;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }

        this.onGround = landed || checkGround();

        // Gentle bobbing when idle
        const t = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) * 0.001;
        const bob = this.onGround ? Math.sin(t * 5) * 0.03 : 0;

        if (this.mesh) {
            this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);
            this.mesh.rotation.y = this.yaw;
        }
    }
}

class SacculariusMole {
    constructor(position = new THREE.Vector3(), survivalMode = false, gameInstance = null) {
        this.position = position.clone();
        this.game = gameInstance;
        this.yaw = 0;
        this.speed = 0.1;
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.22, halfY: 0.18, halfZ: 0.3 };
        this.onGround = false;
        this.jumpPower = 0.18;
        this.jumpCooldown = 500;
        this.lastJumpTime = 0;
        this.mesh = null;
        this.survivalMode = survivalMode;
        this.maxHealth = 8;
        this.health = 8;
        this.isDead = false;
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.06;
        this.damageFlashUntil = 0;
        this.lastStealTime = 0;
        this.stealCooldown = 2200;
    }

    createMesh() {
        const group = new THREE.Group();
        const fur = new THREE.MeshLambertMaterial({ color: 0x5c4634 });
        const belly = new THREE.MeshLambertMaterial({ color: 0x8b7157 });
        const claws = new THREE.MeshLambertMaterial({ color: 0xd4b483 });
        const eyes = new THREE.MeshBasicMaterial({ color: 0xffd34d });

        const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.24, 0.62), fur);
        body.castShadow = true;
        group.add(body);

        const back = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.28), belly);
        back.position.set(0, 0.14, -0.04);
        back.castShadow = true;
        group.add(back);

        const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.22), fur);
        head.position.set(0, 0.04, 0.36);
        head.castShadow = true;
        group.add(head);

        const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.08), belly);
        nose.position.set(0, 0.02, 0.48);
        group.add(nose);

        const leftClaw = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.16), claws);
        leftClaw.position.set(-0.18, -0.08, 0.18);
        leftClaw.castShadow = true;
        group.add(leftClaw);

        const rightClaw = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.16), claws);
        rightClaw.position.set(0.18, -0.08, 0.18);
        rightClaw.castShadow = true;
        group.add(rightClaw);

        const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), eyes);
        leftEye.position.set(-0.08, 0.08, 0.44);
        group.add(leftEye);

        const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), eyes);
        rightEye.position.set(0.08, 0.08, 0.44);
        group.add(rightEye);

        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.28), belly);
        tail.position.set(0, -0.02, -0.44);
        tail.castShadow = true;
        group.add(tail);

        group.position.copy(this.position);
        this.mesh = group;
        return group;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.12, 0.12];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        this.onGround = checkGround();
        if (!this.onGround) this.velocity.y -= this.gravity;

        const toPlayer = targetPlayer.position.clone().sub(this.position);
        const playerDistance = toPlayer.length();
        const fleeing = playerDistance < 4;

        if (now >= this.nextWanderChange) {
            if (fleeing && playerDistance > 0.01) {
                toPlayer.normalize().multiplyScalar(-1);
                this.wanderDir = new THREE.Vector3(toPlayer.x, 0, toPlayer.z);
            } else {
                const angle = Math.random() * Math.PI * 2;
                this.wanderDir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
            }
            this.nextWanderChange = now + 900 + Math.random() * 1600;
        }

        let horizontal = this.wanderDir.clone();
        if (horizontal.length() > 0.05) {
            horizontal.normalize();
            const step = (fleeing ? this.speed : this.wanderSpeed) * Math.max(deltaTime * 60, 1);
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.7;
            this.velocity.z *= 0.7;
        }

        if (this.onGround && horizontal.lengthSq() > 0) {
            const forward = horizontal.clone().normalize();
            const probeX = this.position.x + forward.x * (halfX + 0.16);
            const probeZ = this.position.z + forward.z * (halfZ + 0.16);
            const footY = Math.floor(this.position.y - halfY - 0.01);
            const headY = Math.floor(this.position.y + halfY + 0.15);
            const baseBlock = world.getBlock(Math.floor(probeX), footY, Math.floor(probeZ));
            const aboveBlock = world.getBlock(Math.floor(probeX), footY + 1, Math.floor(probeZ));
            const headClear = !world.isBlockSolid(world.getBlock(Math.floor(probeX), headY, Math.floor(probeZ)));
            if (world.isBlockSolid(baseBlock) && !world.isBlockSolid(aboveBlock) && headClear) {
                if (now - this.lastJumpTime >= this.jumpCooldown) {
                    this.velocity.y = this.jumpPower;
                    this.onGround = false;
                    this.lastJumpTime = now;
                }
            }
        }

        const isSolidAt = (pos) => world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        const hasCollision = (pos) => {
            const pts = [
                [pos.x - halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z + halfZ]
            ];
            for (const p of pts) if (isSolidAt(p)) return true;
            return false;
        };

        const nextPos = this.position.clone();
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) this.position.x = nextPos.x; else this.velocity.x = 0;

        nextPos.z = this.position.z + this.velocity.z;
        nextPos.x = this.position.x;
        if (!hasCollision(nextPos)) this.position.z = nextPos.z; else this.velocity.z = 0;

        nextPos.y = this.position.y + this.velocity.y;
        nextPos.x = this.position.x;
        nextPos.z = this.position.z;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) this.position.y = by + 1 + halfY + 0.001;
                landed = true;
            }
            this.velocity.y = 0;
        }

        this.onGround = landed || checkGround();

        if (playerDistance < 1.8 && now - this.lastStealTime >= this.stealCooldown) {
            const stolen = this.game && typeof this.game.changePlayerGold === 'function'
                ? this.game.changePlayerGold(-1, 'Saccularius Mole theft')
                : 0;
            if (stolen < 0) {
                this.lastStealTime = now;
                this.wanderDir = this.position.clone().sub(targetPlayer.position).setY(0).normalize();
                console.log('The Saccularius Mole stole 1 gold!');
            }
        }

        if (now < this.damageFlashUntil && this.mesh) {
            this.mesh.traverse(child => {
                if (child.isMesh && child.material) {
                    child.material.emissive = child.material.emissive || new THREE.Color(0x000000);
                    child.material.emissive.setHex(0xff5500);
                    child.material.emissiveIntensity = 0.9;
                }
            });
        } else if (this.damageFlashUntil > 0 && this.mesh) {
            this.mesh.traverse(child => {
                if (child.isMesh && child.material) {
                    child.material.emissive = child.material.emissive || new THREE.Color(0x000000);
                    child.material.emissive.setHex(0x000000);
                    child.material.emissiveIntensity = 0;
                }
            });
            this.damageFlashUntil = 0;
        }

        const t = now * 0.001;
        const bob = this.onGround ? Math.sin(t * 6) * 0.02 : 0;
        if (this.mesh) {
            this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);
            this.mesh.rotation.y = this.yaw;
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;

        this.health = Math.max(0, this.health - amount);
        this.damageFlashUntil = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) + 200;

        if (knockbackDir) {
            this.velocity.x = knockbackDir.x * 0.25;
            this.velocity.z = knockbackDir.z * 0.25;
            this.velocity.y = 0.12;
        }

        if (this.health <= 0) {
            this.isDead = true;
            console.log('Saccularius Mole died!');
            return true;
        }
        return false;
    }
}

class Minutor {
    constructor(position = new THREE.Vector3(), survivalMode = false) {
        this.position = position.clone();
        this.yaw = 0;
        this.speed = 0.07; // Slow but powerful
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.4, halfY: 0.9, halfZ: 0.4 }; // Larger than piggron
        this.onGround = false;
        this.jumpPower = 0.3;
        this.jumpCooldown = 300; // ms
        this.lastJumpTime = 0;
        this.mesh = null;
        
        // Survival mode
        this.survivalMode = survivalMode;
        this.maxHealth = 20;
        this.health = 20;
        this.isDead = false;
        this.attackDamage = 15;
        this.attackCooldown = 1200; // ms between attacks
        this.lastAttackTime = 0;
        this.isAggressive = true; // Always aggressive (unlike piggron)
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.04;
        
        // Damage flash effect
        this.damageFlashUntil = 0;
        this.originalMaterials = [];
    }

    createMesh() {
        const group = new THREE.Group();

        // Dark brown/black skin for a menacing look
        const skin = new THREE.MeshLambertMaterial({ color: 0x2a1810 });
        const accent = new THREE.MeshLambertMaterial({ color: 0x8B0000 }); // Dark red accents

        // Larger torso
        const torsoGeo = new THREE.BoxGeometry(0.9, 1.2, 0.5);
        const torso = new THREE.Mesh(torsoGeo, skin);
        torso.castShadow = true;
        group.add(torso);

        // Bull-like head with horns
        const headGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
        const head = new THREE.Mesh(headGeo, skin);
        head.position.y = 1.2;
        head.castShadow = true;
        group.add(head);

        // Horns
        const hornGeo = new THREE.ConeGeometry(0.08, 0.4, 6);
        const hornMat = new THREE.MeshLambertMaterial({ color: 0xcccccc });
        const hornLeft = new THREE.Mesh(hornGeo, hornMat);
        hornLeft.position.set(-0.3, 1.5, 0);
        hornLeft.rotation.z = Math.PI / 6;
        hornLeft.castShadow = true;
        group.add(hornLeft);
        
        const hornRight = new THREE.Mesh(hornGeo, hornMat);
        hornRight.position.set(0.3, 1.5, 0);
        hornRight.rotation.z = -Math.PI / 6;
        hornRight.castShadow = true;
        group.add(hornRight);

        // Legs
        const legGeo = new THREE.BoxGeometry(0.3, 0.8, 0.3);
        const legOffsets = [-0.25, 0.25];
        legOffsets.forEach(x => {
            const leg = new THREE.Mesh(legGeo, accent);
            leg.position.set(x, -1.0, 0);
            leg.castShadow = true;
            group.add(leg);
        });

        // Arms
        const armGeo = new THREE.BoxGeometry(0.25, 0.7, 0.25);
        const armOffsets = [-0.6, 0.6];
        armOffsets.forEach(x => {
            const arm = new THREE.Mesh(armGeo, accent);
            arm.position.set(x, 0.2, 0);
            arm.castShadow = true;
            group.add(arm);
        });

        // Red eyes (just red, no pupils)
        const eyeRed = new THREE.MeshLambertMaterial({ color: 0xff0000 });
        
        // Left eye
        const eyeGeo = new THREE.SphereGeometry(0.1, 8, 8);
        const leftEye = new THREE.Mesh(eyeGeo, eyeRed);
        leftEye.position.set(-0.18, 1.45, 0.36);
        leftEye.castShadow = true;
        group.add(leftEye);
        
        // Right eye
        const rightEye = new THREE.Mesh(eyeGeo, eyeRed);
        rightEye.position.set(0.18, 1.45, 0.36);
        rightEye.castShadow = true;
        group.add(rightEye);

        group.position.copy(this.position);
        this.mesh = group;
        
        // Store original materials for damage flash
        this.originalMaterials = [];
        group.traverse(child => {
            if (child.isMesh) {
                this.originalMaterials.push({
                    mesh: child,
                    material: child.material
                });
            }
        });
        
        return group;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const debugStart = performance.now();
        const now = performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.25, 0.25];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        // Keep grounded state stable before applying gravity
        this.onGround = checkGround();

        // Apply gravity
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        const nowMove = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        // Check if player is visible (line of sight)
        const toPlayer = targetPlayer.position.clone().sub(this.position);
        const distanceToPlayer = toPlayer.length();
        let canSeePlayer = false;

        if (distanceToPlayer < 20) { // Only check line of sight within 20 blocks
            const steps = Math.ceil(distanceToPlayer);
            const stepDir = toPlayer.clone().normalize();
            let blocked = false;

            for (let i = 1; i < steps; i++) {
                const checkPos = this.position.clone().addScaledVector(stepDir, i);
                const bx = Math.floor(checkPos.x);
                const by = Math.floor(checkPos.y);
                const bz = Math.floor(checkPos.z);
                
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    blocked = true;
                    break;
                }
            }
            canSeePlayer = !blocked;
        }

        // Chase player only if visible, otherwise wander
        let horizontal = new THREE.Vector3();
        if (canSeePlayer) {
            horizontal.set(toPlayer.x, 0, toPlayer.z);
        } else {
            // Wander when player not visible
            if (nowMove >= this.nextWanderChange) {
                const pause = Math.random() < 0.25;
                if (pause) {
                    this.wanderDir = new THREE.Vector3(0, 0, 0);
                } else {
                    const angle = Math.random() * Math.PI * 2;
                    this.wanderDir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
                }
                this.nextWanderChange = nowMove + 1500 + Math.random() * 2000;
            }
            horizontal.copy(this.wanderDir);
        }

        const distance = horizontal.length();
        if (distance > 0.05) {
            horizontal.normalize();
            const moveSpeed = canSeePlayer ? this.speed : this.wanderSpeed;
            const step = moveSpeed * Math.max(deltaTime * 60, 1);
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.6;
            this.velocity.z *= 0.6;
        }

        // Attempt a small hop over single-block obstacles while moving
        if (this.onGround && distance > 0.05) {
            const lookX = Math.sin(this.yaw) * 0.6;
            const lookZ = Math.cos(this.yaw) * 0.6;
            const feetY = this.position.y - halfY;
            const floorY = Math.floor(feetY);
            const bx = Math.floor(this.position.x + lookX);
            const bz = Math.floor(this.position.z + lookZ);
            
            const blockInFront = world.getBlock(bx, floorY, bz);
            const blockAbove = world.getBlock(bx, floorY + 1, bz);
            
            if (world.isBlockSolid(blockInFront) && !world.isBlockSolid(blockAbove)) {
                if (now - this.lastJumpTime >= this.jumpCooldown) {
                    this.velocity.y = this.jumpPower;
                    this.lastJumpTime = now;
                }
            }
        }

        // Collision detection
        const hasCollision = (testPos) => {
            const offsets = [
                [-halfX, -halfY, -halfZ], [halfX, -halfY, -halfZ],
                [-halfX, -halfY, halfZ], [halfX, -halfY, halfZ],
                [-halfX, halfY, -halfZ], [halfX, halfY, -halfZ],
                [-halfX, halfY, halfZ], [halfX, halfY, halfZ]
            ];
            for (const [ox, oy, oz] of offsets) {
                const px = testPos.x + ox;
                const py = testPos.y + oy;
                const pz = testPos.z + oz;
                const bx = Math.floor(px);
                const by = Math.floor(py);
                const bz = Math.floor(pz);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) return true;
            }
            return false;
        };

        // X movement
        let nextPos = this.position.clone();
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }

        // Z movement
        nextPos = this.position.clone();
        nextPos.z += this.velocity.z;
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }

        // Y movement
        nextPos = this.position.clone();
        nextPos.y += this.velocity.y;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }

        this.onGround = landed || checkGround();

        // Attack player only if visible
        if (this.survivalMode && !targetPlayer.isDead && canSeePlayer) {
            const dist = this.position.distanceTo(targetPlayer.position);
            if (dist < 2.5) { // Slightly longer attack range
                if (now - this.lastAttackTime >= this.attackCooldown) {
                    targetPlayer.takeDamage(this.attackDamage, this);
                    this.lastAttackTime = now;
                }
            }
        }

        // Idle bobbing visual only when on ground
        const t = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bob = this.onGround ? Math.sin(t * 4) * 0.05 : 0;

        // Update damage flash effect
        if (now < this.damageFlashUntil) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0xff0000);
                        child.material.emissiveIntensity = 0.8;
                    }
                });
            }
        } else if (this.damageFlashUntil > 0) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0x000000);
                        child.material.emissiveIntensity = 0;
                    }
                });
            }
            this.damageFlashUntil = 0;
        }

        if (this.mesh) {
            this.mesh.position.copy(this.position);
            this.mesh.position.y += bob;
            this.mesh.rotation.y = this.yaw;
        }

        const debugElapsed = performance.now() - debugStart;
        if (debugElapsed > 10) {
            console.log(`[PERF] Minutor update took ${debugElapsed.toFixed(2)}ms`);
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;
        
        this.health = Math.max(0, this.health - amount);
        console.log(`Minutor took ${amount} damage! Health: ${this.health}/${this.maxHealth}`);
        
        // Apply red flash effect for 200ms
        const now = performance.now ? performance.now() : Date.now();
        this.damageFlashUntil = now + 200;
        
        // Apply knockback
        if (knockbackDir) {
            const knockbackStrength = 0.25; // Slightly harder to knockback
            this.velocity.x = knockbackDir.x * knockbackStrength;
            this.velocity.z = knockbackDir.z * knockbackStrength;
            this.velocity.y = 0.12;
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            console.log('Minutor died!');
            return true; // Died
        }
        return false; // Still alive
    }
}

class Phinox {
    constructor(position = new THREE.Vector3()) {
        this.position = position.clone();
        this.yaw = 0;
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.size = { halfX: 0.6, halfY: 0.6, halfZ: 0.6 };
        this.mesh = null;
        this.isMounted = false;
        this.rider = null;
        this.flySpeed = 0.25;
        this.hoverHeight = 0;
        this.spawnTime = performance.now();
    }

    createMesh() {
        const group = new THREE.Group();

        const fireMat = new THREE.MeshStandardMaterial({ 
            color: 0xff4500, 
            emissive: 0xff6600,
            emissiveIntensity: 1.5
        });
        const glowMat = new THREE.MeshStandardMaterial({ 
            color: 0xffaa00, 
            emissive: 0xff8800,
            emissiveIntensity: 2.0
        });

        const bodyGeo = new THREE.BoxGeometry(0.8, 0.6, 1.2);
        const body = new THREE.Mesh(bodyGeo, fireMat);
        body.castShadow = true;
        group.add(body);

        const headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
        const head = new THREE.Mesh(headGeo, glowMat);
        head.position.set(0, 0.3, -0.7);
        head.castShadow = true;
        group.add(head);

        // Eyes - two black dots (positioned on front face at -Z)
        const eyeBlack = new THREE.MeshBasicMaterial({ color: 0x000000 });
        const eyeGeo = new THREE.SphereGeometry(0.08, 8, 8);
        
        const leftEye = new THREE.Mesh(eyeGeo, eyeBlack);
        leftEye.position.set(-0.15, 0.35, -0.95);
        group.add(leftEye);
        
        const rightEye = new THREE.Mesh(eyeGeo, eyeBlack);
        rightEye.position.set(0.15, 0.35, -0.95);
        group.add(rightEye);

        const wingGeo = new THREE.BoxGeometry(1.5, 0.1, 0.8);
        const leftWing = new THREE.Mesh(wingGeo, fireMat);
        leftWing.position.set(-1.0, 0.2, 0);
        leftWing.castShadow = true;
        group.add(leftWing);

        const rightWing = new THREE.Mesh(wingGeo, fireMat);
        rightWing.position.set(1.0, 0.2, 0);
        rightWing.castShadow = true;
        group.add(rightWing);

        const tailGeo = new THREE.BoxGeometry(0.4, 0.3, 1.0);
        const tail = new THREE.Mesh(tailGeo, glowMat);
        tail.position.set(0, 0, -0.8);
        tail.castShadow = true;
        group.add(tail);

        this.leftWing = leftWing;
        this.rightWing = rightWing;

        group.position.copy(this.position);
        this.mesh = group;
    }

    update(deltaTime, playerInput = null, world = null) {
        if (!this.mesh) return;

        const now = performance.now();
        const flapSpeed = this.isMounted ? 8 : 4;
        const flapAngle = Math.sin(now * 0.01 * flapSpeed) * 0.3;
        if (this.leftWing) this.leftWing.rotation.z = flapAngle;
        if (this.rightWing) this.rightWing.rotation.z = -flapAngle;

        if (this.isMounted && playerInput) {
            const forward = new THREE.Vector3(0, 0, -1);
            forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

            const right = new THREE.Vector3(1, 0, 0);
            right.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

            this.velocity.set(0, 0, 0);

            if (playerInput.forward) {
                this.velocity.add(forward.multiplyScalar(this.flySpeed));
            }
            if (playerInput.backward) {
                this.velocity.add(forward.multiplyScalar(-this.flySpeed * 0.5));
            }
            if (playerInput.left) {
                this.velocity.add(right.clone().multiplyScalar(-this.flySpeed * 0.7));
            }
            if (playerInput.right) {
                this.velocity.add(right.clone().multiplyScalar(this.flySpeed * 0.7));
            }
            if (playerInput.jump) {
                this.velocity.y = this.flySpeed * 0.8;
            }
            if (playerInput.sneak) {
                this.velocity.y = -this.flySpeed * 0.8;
            }

            // Apply velocity with collision detection
            const testPos = this.position.clone().add(this.velocity);
            
            if (world) {
                // Check collision with block at new position (using Phinox size)
                const { halfX, halfY, halfZ } = this.size;
                
                // Sample corners to check for solid blocks
                const corners = [
                    [testPos.x - halfX, testPos.y - halfY, testPos.z - halfZ],
                    [testPos.x + halfX, testPos.y + halfY, testPos.z + halfZ],
                    [testPos.x - halfX, testPos.y + halfY, testPos.z - halfZ],
                    [testPos.x + halfX, testPos.y - halfY, testPos.z + halfZ]
                ];
                
                let canMove = true;
                for (const [x, y, z] of corners) {
                    const block = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
                    if (world.isBlockSolid(block)) {
                        canMove = false;
                        break;
                    }
                }
                
                if (canMove) {
                    this.position.copy(testPos);
                }
            } else {
                this.position.add(this.velocity);
            }
        } else {
            this.hoverHeight = Math.sin((now - this.spawnTime) * 0.002) * 0.15;
            this.position.y += this.hoverHeight * deltaTime * 60;
        }

        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.yaw;
    }

    mount(player) {
        this.isMounted = true;
        this.rider = player;
    }

    dismount() {
        this.isMounted = false;
        this.rider = null;
    }
}


class Item {
    constructor(type, amount = 1) {
        this.type = type;
        this.amount = amount;
        this.maxStack = 99;
    }

    canStack(otherItem) {
        return otherItem && otherItem.type === this.type && this.amount < this.maxStack;
    }

    addAmount(amt) {
        const space = this.maxStack - this.amount;
        const toAdd = Math.min(space, amt);
        this.amount += toAdd;
        return amt - toAdd; // Return remaining amount that couldn't be added
    }

    removeAmount(amt) {
        const toRemove = Math.min(this.amount, amt);
        this.amount -= toRemove;
        return toRemove;
    }

    isEmpty() {
        return this.amount <= 0;
    }

    clone() {
        return new Item(this.type, this.amount);
    }
}

class DroppedItem {
    constructor(position, itemType, amount = 1) {
        this.position = position.clone();
        this.itemType = itemType;
        this.amount = amount;
        this.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.1,
            0.2,
            (Math.random() - 0.5) * 0.1
        );
        this.gravity = 0.015;
        this.onGround = false;
        this.lifetime = 0; // Track lifetime for despawn (300 seconds = 5 minutes)
        this.maxLifetime = 300;
        this.sprite = null;
        this.bobOffset = Math.random() * Math.PI * 2; // Random bob phase
    }


    createSprite(textureAtlas, blockNames, itemTexture) {
        // Create a 2D sprite for the dropped item using individual PNG texture
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        // If item texture exists, draw it; otherwise use colored squares
        if (itemTexture && itemTexture.image) {
            // Draw the entire item PNG (16x16) at native size
            ctx.imageSmoothingEnabled = false; // Pixelated look
            ctx.drawImage(
                itemTexture.image,
                0, 0, 16, 16,  // Source entire image
                24, 24, 16, 16 // Draw to canvas centered at native 16x16
            );
        } else {
            // Fallback: colored squares
            const colors = {
                1: '#8B4513',  // Dirt
                2: '#228B22',  // Grass
                3: '#808080',  // Stone
                4: '#F4D03F',  // Sand
                5: '#0099FF',  // Water
                6: '#CD853F',  // Wood
                7: '#A0523D',  // Bricks
                8: '#E81828',  // Ruby
                9: '#D4623D',  // Clay
                10: '#F0F8FF', // Snow
                11: '#228B22', // Leafs
                12: '#0047AB', // Sapphire
                13: '#D2B48C', // Plank
                14: '#FFFFFF', // Paper
                15: '#8B4513', // Stick
                16: '#F5DEB3', // Scroll
                17: '#FFC0CB', // Pork
                18: '#8B4726', // Leather Helmet (brown leather)
                19: '#8B4726', // Leather Chestplate
                20: '#8B4726', // Leather Leggings
                21: '#8B4726', // Leather Boots
                22: '#708090', // Stone Sword (slate gray)
                23: '#DEB887', // Wood Shield (burlywood)
                24: '#000000', // Coal (black)
                25: '#FFD700', // Torch (golden yellow)
                26: '#8B4513', // Chest (brown wood)
                27: '#9370DB', // Mana Orb (medium purple)
                28: '#FFD700', // Fortitudo Scroll (golden yellow)
                29: '#87CEEB', // Magic candle (sky blue)
                30: '#696969', // Chisel (dim gray)
                31: '#F0F8FF', // Cloud Pillow (alice blue)
                32: '#FFD700', // Golden Sword (gold)
                33: '#2c2c2c', // Grim Stone (very dark gray)
                34: '#FF4500', // Lava (orange-red)
                40: '#FF0000', // TNT (red)
                35: '#FFB6C1', // Smiteth Scroll (light pink)
                36: '#1a1a2e', // Gloom (very dark blue/black)
                41: '#e6d28a', // Map
                42: '#6f7078', // Cauldron
                43: '#d42424', // Healing Potion
                44: '#7fd8ff', // Potion of Chilling
                49: '#7CFC00', // Astara Scroll (lime)
                50: '#00CED1', // Cloutump Scroll (turquoise)
                51: '#b56cff', // Rune of the Batter (violet)
                52: '#ff3355', // Life Contaner (crimson)
                53: '#33ccff', // Energy Vesseil (cyan)
                64: '#ff4a4a', // Red Sconce
                65: '#5a8dff'  // Blue Sconce
            };

            const color = colors[this.itemType] || '#FFFFFF';
            ctx.fillStyle = color;
            ctx.fillRect(8, 8, 48, 48);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            ctx.strokeRect(8, 8, 48, 48);
        }

        // Add amount text if > 1
        if (this.amount > 1) {
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 3;
            ctx.font = 'bold 20px Arial';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.strokeText(this.amount.toString(), 56, 56);
            ctx.fillText(this.amount.toString(), 56, 56);
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const material = new THREE.SpriteMaterial({ 
            map: texture,
            transparent: true,
            depthTest: true,
            depthWrite: false
        });

        this.sprite = new THREE.Sprite(material);
        this.sprite.scale.set(0.4, 0.4, 1);
        this.sprite.position.copy(this.position);

        return this.sprite;
    }

    update(world, deltaTime) {
        this.lifetime += deltaTime;

        // Apply gravity
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        // Apply velocity
        this.position.add(this.velocity);

        // Simple ground collision
        const groundY = Math.floor(this.position.y - 0.2);
        const groundBlock = world.getBlock(
            Math.floor(this.position.x),
            groundY,
            Math.floor(this.position.z)
        );

        if (world.isBlockSolid(groundBlock) && this.velocity.y < 0) {
            this.position.y = groundY + 1.2;
            this.velocity.y = 0;
            this.velocity.x *= 0.8;
            this.velocity.z *= 0.8;
            this.onGround = true;
        }

        // Bobbing animation
        const bobTime = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bobY = Math.sin(bobTime * 2 + this.bobOffset) * 0.1;

        // Update sprite position
        if (this.sprite) {
            this.sprite.position.copy(this.position);
            this.sprite.position.y += bobY;
            
            // Slow rotation
            this.sprite.material.rotation += deltaTime * 0.5;
        }

        // Check if should despawn
        return this.lifetime < this.maxLifetime;
    }

    canPickup(playerPos, pickupRange = 1.5) {
        return this.position.distanceTo(playerPos) < pickupRange;
    }
}

// Simple projectile used by the musket.  Behaves as a small block that travels
// straight and damages the first entity it hits.  It is managed by the Game
// instance via the `projectiles` array.
class Projectile {
    constructor(position, direction, speed, damage, owner) {
        this.position = position.clone();
        this.velocity = direction.clone().normalize().multiplyScalar(speed);
        this.damage = damage;
        this.owner = owner;
        this.mesh = null;
        this.lifetime = 0;
        this.maxLifetime = 5; // seconds before disappearing
        this.createMesh();
    }

    createMesh() {
        const geom = new THREE.BoxGeometry(0.2, 0.2, 0.2);
        const mat = new THREE.MeshBasicMaterial({ color: 0xaaaaaa });
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.position.copy(this.position);
        // simple lighting hack so bullet is visible
        this.mesh.castShadow = false;
        if (window.game && game.scene) {
            try { game.scene.add(this.mesh); } catch (e) {}
        }
    }

    update(deltaTime, game) {
        this.lifetime += deltaTime;
        if (this.lifetime > this.maxLifetime) {
            this.destroy(game);
            return false;
        }

        const move = this.velocity.clone().multiplyScalar(deltaTime * 60);
        this.position.add(move);
        if (this.mesh) this.mesh.position.copy(this.position);

        // world collision
        const x = Math.floor(this.position.x);
        const y = Math.floor(this.position.y);
        const z = Math.floor(this.position.z);
        const block = game.world.getBlock(x, y, z);
        if (block !== 0) {
            this.destroy(game);
            return false;
        }

        // entity collision (pigmen, priests, minutors)
        const hits = [];
        if (game.pigmen && game.pigmen.length) hits.push(...game.pigmen);
        if (game.piggronPriest && !game.piggronPriest.isDead) hits.push(game.piggronPriest);
        if (game.minutors && game.minutors.length) hits.push(...game.minutors);
        if (game.slimes && game.slimes.length) hits.push(...game.slimes);
        for (const ent of hits) {
            if (!ent || ent.isDead) continue;
            const distSq = this.position.distanceToSquared(ent.position);
            // give a bit more forgiveness vs. tiny hitbox
            if (distSq < 0.7 * 0.7) {
                let died = false;
                if (ent.takeDamage) died = !!ent.takeDamage(this.damage, this.owner);
                if (died && game && typeof game.finalizeEnemyDeath === 'function') {
                    game.finalizeEnemyDeath(ent, 'musket');
                }
                this.destroy(game);
                return false;
            }
        }
        // multiplayer other player
        if (game.isMultiplayer && game.otherPlayer && !game.otherPlayer.isDead) {
            const distSq = this.position.distanceToSquared(game.otherPlayer.position);
            if (distSq < 0.7 * 0.7) {
                if (game.otherPlayer.takeDamage) game.otherPlayer.takeDamage(this.damage, this.owner);
                this.destroy(game);
                return false;
            }
        }

        return true;
    }

    destroy(game) {
        if (this.mesh) {
            try { game.scene.remove(this.mesh); } catch (e) {}
            this.mesh = null;
        }
    }
}

class ItemManager {
    constructor(scene, world, textureAtlas, blockNames) {
        this.scene = scene;
        this.world = world;
        this.textureAtlas = textureAtlas;
        this.blockNames = blockNames;
        this.droppedItems = [];
        this.itemTextures = new Map(); // Map of itemType -> texture
        
        // Load individual item textures (item_1.png, item_2.png, etc.)
        const textureLoader = new THREE.TextureLoader();
        // load textures for known item blocks
        for (let i = 1; i <= 44; i++) {
            textureLoader.load(
                `item_${i}.png`,
                (texture) => {
                    texture.magFilter = THREE.NearestFilter;
                    texture.minFilter = THREE.NearestFilter;
                    this.itemTextures.set(i, texture);
                    console.log(`Item texture ${i} loaded successfully`);
                },
                undefined,
                (error) => {
                    console.log(`Item texture item_${i}.png not found, will use fallback colors`);
                }
            );
        }
    }

    dropItem(position, itemType, amount = 1) {
        const droppedItem = new DroppedItem(position, itemType, amount);
        const itemTexture = this.itemTextures.get(itemType) || null;
        const sprite = droppedItem.createSprite(this.textureAtlas, this.blockNames, itemTexture);
        this.scene.add(sprite);
        this.droppedItems.push(droppedItem);
        return droppedItem;
    }

    update(player, deltaTime) {
        // Update all dropped items
        for (let i = this.droppedItems.length - 1; i >= 0; i--) {
            const item = this.droppedItems[i];
            const shouldKeep = item.update(this.world, deltaTime);

            // Check for pickup
            if (item.canPickup(player.position)) {
                // Try to add to player inventory
                let remaining = item.amount;
                
                // Try to stack with existing items first
                for (let j = 0; j < player.inventory.length && remaining > 0; j++) {
                    const slot = player.inventory[j];
                    if (slot && typeof slot === 'object' && slot.type === item.itemType && slot.amount < 99) {
                        const space = 99 - slot.amount;
                        const toAdd = Math.min(space, remaining);
                        slot.amount += toAdd;
                        remaining -= toAdd;
                    }
                }

                // Then fill empty slots
                for (let j = 0; j < player.inventory.length && remaining > 0; j++) {
                    if (player.inventory[j] === 0) {
                        const toAdd = Math.min(99, remaining);
                        player.inventory[j] = { type: item.itemType, amount: toAdd };
                        remaining -= toAdd;
                    }
                }

                // Remove picked up items (or reduce amount if inventory was full)
                if (remaining === 0) {
                    this.removeDroppedItem(i);
                    // Return true to indicate an item was picked up
                    return true;
                } else {
                    item.amount = remaining;
                }
            } else if (!shouldKeep) {
                // Despawn old items
                this.removeDroppedItem(i);
            }
        }
        return false;
    }

    removeDroppedItem(index) {
        if (index >= 0 && index < this.droppedItems.length) {
            const item = this.droppedItems[index];
            if (item.sprite) {
                this.scene.remove(item.sprite);
                if (item.sprite.material && item.sprite.material.map) {
                    item.sprite.material.map.dispose();
                }
                if (item.sprite.material) {
                    item.sprite.material.dispose();
                }
            }
            this.droppedItems.splice(index, 1);
        }
    }

    clear() {
        for (let i = this.droppedItems.length - 1; i >= 0; i--) {
            this.removeDroppedItem(i);
        }
    }
}

class TestSalesmen {
    constructor(position = new THREE.Vector3()) {
        this.position = position.clone();
        this.spawnOrigin = position.clone();
        this.yaw = 0;
        this.mesh = null;
        this.speed = 0.03;
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.homeAnchor = null; // { x, y, z } center + floorY
        this.homeCheckCooldown = 0;
        this.homeForcedByCommand = false;
    }

    getHomeCenterPosition(home) {
        if (!home) return null;
        return new THREE.Vector3(
            Number.isFinite(home.centerX) ? home.centerX : (home.x + 0.5),
            Number.isFinite(home.centerY) ? home.centerY : (home.y + 1.1),
            Number.isFinite(home.centerZ) ? home.centerZ : (home.z + 0.5)
        );
    }

    teleportToHomeCenter(home) {
        const center = this.getHomeCenterPosition(home);
        if (!center) return;
        this.position.copy(center);
    }

    createMesh() {
        const group = new THREE.Group();

        const bodyMat = new THREE.MeshLambertMaterial({ color: 0xdd3333 });
        const accentMat = new THREE.MeshLambertMaterial({ color: 0x992222 });

        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.0, 0.4), bodyMat);
        torso.position.y = 0.0;
        torso.castShadow = true;
        group.add(torso);

        const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), bodyMat);
        head.position.y = 0.9;
        head.castShadow = true;
        group.add(head);

        const legs = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.35), accentMat);
        legs.position.y = -0.9;
        legs.castShadow = true;
        group.add(legs);

        const labelCanvas = document.createElement('canvas');
        labelCanvas.width = 320;
        labelCanvas.height = 72;
        const ctx = labelCanvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(0, 0, labelCanvas.width, labelCanvas.height);
        ctx.fillStyle = '#ff6b6b';
        ctx.font = 'Bold 34px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('test_salesmen', 160, 46);

        const labelTex = new THREE.CanvasTexture(labelCanvas);
        const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true });
        const label = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.4), labelMat);
        label.position.y = 1.5;
        label.userData.isNameLabel = true;
        group.add(label);

        group.position.copy(this.position);
        this.mesh = group;
        return group;
    }

    update(world, targetPlayer, deltaTime, game) {
        if (!world || !targetPlayer || !game) return;

        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const frameScale = Math.max(deltaTime * 60, 1);

        if (this.homeAnchor && !this.homeForcedByCommand) {
            if (!game.isValidTestSalesmenHome(this.homeAnchor.x, this.homeAnchor.y, this.homeAnchor.z)) {
                this.homeAnchor = null;
            }
        }

        if (!this.homeAnchor) {
            this.homeCheckCooldown -= deltaTime;
            if (this.homeCheckCooldown <= 0) {
                this.homeCheckCooldown = 1.25;
                const foundHome = game.findTestSalesmenHomeNear(targetPlayer.position, 18);
                if (foundHome) {
                    this.homeAnchor = foundHome;
                    this.teleportToHomeCenter(foundHome);
                    this.wanderDir.set(0, 0, 0);
                }
            }
        }

        if (!this.homeAnchor) {
            if (now >= this.nextWanderChange) {
                const angle = Math.random() * Math.PI * 2;
                this.wanderDir.set(Math.sin(angle), 0, Math.cos(angle));
                this.nextWanderChange = now + 1000 + Math.random() * 2200;
            }

            // Keep movement centered around spawn so he doesn't drift too far away.
            const fromSpawn = new THREE.Vector3(
                this.position.x - this.spawnOrigin.x,
                0,
                this.position.z - this.spawnOrigin.z
            );
            if (fromSpawn.lengthSq() > (18 * 18)) {
                fromSpawn.normalize().multiplyScalar(-1);
                this.wanderDir.copy(fromSpawn);
            }

            const step = this.speed * frameScale;
            const nextX = this.position.x + this.wanderDir.x * step;
            const nextZ = this.position.z + this.wanderDir.z * step;
            const targetSurfaceY = world.getTerrainHeight(Math.floor(nextX), Math.floor(nextZ));
            if (Number.isFinite(targetSurfaceY)) {
                const targetY = targetSurfaceY + 1.1;
                if (Math.abs(targetY - this.position.y) <= 1.3) {
                    this.position.x = nextX;
                    this.position.z = nextZ;
                    this.position.y += (targetY - this.position.y) * 0.25;
                    this.yaw = Math.atan2(this.wanderDir.x, this.wanderDir.z);
                }
            }
        } else {
            this.teleportToHomeCenter(this.homeAnchor);
        }

        if (this.mesh) {
            this.mesh.position.copy(this.position);
            this.mesh.rotation.y = this.yaw;
            this.mesh.children.forEach((child) => {
                if (child.userData.isNameLabel && game.camera) child.lookAt(game.camera.position);
            });
        }
    }
}

class Game {
    constructor(worldType = 'default', isMultiplayer = false, team = 'red', playerName = 'Player', survivalMode = true, playerColor = null, playerEmail = null) {
        console.log('Game constructor started');
        
        this.playerName = playerName;
        this.playerEmail = playerEmail; // Store email
        this.survivalMode = survivalMode;
        this.customPlayerColor = playerColor; // Store custom color
        
        // Game music setup
        this.gameMusic = new Audio('Posey.ogg');
        this.gameMusic.preload = 'auto';
        this.gameMusic.volume = 0.65;
        this.gameMusic.muted = false;
        this.gameMusic.loop = true;
        this._currentMusicTrack = 'Posey.ogg';
        this.audioUnlocked = false;
        this.lastAudioEnsureTime = 0;

        // Browser autoplay can block media until user interaction.
        this.musicUnlockHandler = () => {
            this.audioUnlocked = true;
            this.gameMusic.muted = false;
            if (this.gameMusic.volume < 0.65) this.gameMusic.volume = 0.65;
            this.gameMusic.play().catch(e => console.log('Game music unlock play failed:', e));
        };
        window.addEventListener('pointerdown', this.musicUnlockHandler, { once: true });
        window.addEventListener('keydown', this.musicUnlockHandler, { once: true });
        window.addEventListener('touchstart', this.musicUnlockHandler, { once: true });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.ensureAudioRunning();
        });

        // Sound effects
        this.musketSound = new Audio('Musket.mp3');
        this.musketSound.volume = 0.7; // a bit louder than UI clicks
        this.explosionSound = new Audio('Explotion.ogg');
        this.explosionSound.volume = 0.85;
        this.moneySound = new Audio('money.mp3');
        this.moneySound.preload = 'auto';
        this.moneySound.volume = 0.8;

        
        // Block type to name mapping
        // --- item/block type constants ---
        // NB: IDs above 36 are not currently defined elsewhere, but we
        // reserve 37 for the new musket.  Because musket behaves as an item
        // (not normally placed as terrain) we don't explicitly rely on it
        // being in the placeable set, but we do allow it there so creative
        // users can obtain it via the block picker.
        const MUSKET_TYPE = 37;
        const SLIME_TYPE = 38;
        const MAN_POSTER_TYPE = 39;
        const TNT_TYPE = 40;
        const MAP_TYPE = 41;
        const CAULDRON_TYPE = 42;
        const HEALING_POTION_TYPE = 43;
        const CHILLING_POTION_TYPE = 44;
        const STRUCTURE_BLOCK_TYPE = 45;
        const FAIRIA_PORTAL_BLOCK_TYPE = 46;
        const WOOD_DOOR_TYPE = 47;
        const DUNGEON_DOOR_TYPE = 48;
        const ASTARA_SCROLL_TYPE = 49;
        const CLOUTUMP_SCROLL_TYPE = 50;
        const RUNE_OF_BATTER_TYPE = 51;
        const LIFE_CONTANER_TYPE = 52;
        const ENERGY_VESSEIL_TYPE = 53;
        const AGILITY_CAPE_TYPE = 54;
        const LV1_KEY_TYPE = 55;
        const CONNECTER_BLOCK_TYPE = 56;
        const RED_CLOTH_TYPE = 57;
        const ORANGE_CLOTH_TYPE = 58;
        const YELLOW_CLOTH_TYPE = 59;
        const GREEN_CLOTH_TYPE = 60;
        const BLUE_CLOTH_TYPE = 61;
        const INDIGO_CLOTH_TYPE = 62;
        const VIOLET_CLOTH_TYPE = 63;
        const RED_SCONCE_TYPE = 64;
        const BLUE_SCONCE_TYPE = 65;

        this.blockNames = {
            0: 'Air',
            1: 'Dirt',
            2: 'Grass',
            3: 'Stone',
            4: 'Sand',
            5: 'Water',
            6: 'Wood',
            7: 'Bricks',
            8: 'Ruby',
            9: 'Clay',
            10: 'Snow',
            11: 'Leafs',
            12: 'Sapphire',
            13: 'Plank',
            14: 'Paper',
            15: 'Stick',
            16: 'Scroll',
            17: 'Pork',
            18: 'Leather Helmet',
            19: 'Leather Chestplate',
            20: 'Leather Leggings',
            21: 'Leather Boots',
            22: 'Stone Sword',
            23: 'Wood Shield',
            24: 'Coal',
            25: 'Torch',
            26: 'Chest',
            27: 'Mana Orb',
            28: 'Fortitudo Scroll',
            29: 'Magic candle',
            30: 'Chisel',
            31: 'Cloud Pillow',
            32: 'Golden Sword',
            33: 'Grim Stone',
            34: 'Lava',
            35: 'Smiteth Scroll',
            36: 'Gloom',
            [MUSKET_TYPE]: 'Musket',  // new weapon
            [SLIME_TYPE]: 'Slime',    // dropped by slain slimes
            [MAN_POSTER_TYPE]: 'Man Poster',
            [TNT_TYPE]: 'TNT',
            [MAP_TYPE]: 'Map',
            [CAULDRON_TYPE]: 'Cauldron',
            [HEALING_POTION_TYPE]: 'Healing Potion',
            [CHILLING_POTION_TYPE]: 'Potion of Chilling',
            [STRUCTURE_BLOCK_TYPE]: 'Structure Block',
            [FAIRIA_PORTAL_BLOCK_TYPE]: 'Fairia Portal',
            [WOOD_DOOR_TYPE]: 'Wood Door',
            [DUNGEON_DOOR_TYPE]: 'Dungeon Door',
            [ASTARA_SCROLL_TYPE]: 'Astara Scroll',
            [CLOUTUMP_SCROLL_TYPE]: 'Cloutump Scroll',
            [RUNE_OF_BATTER_TYPE]: 'Rune of the Batter',
            [LIFE_CONTANER_TYPE]: 'Life Contaner',
            [ENERGY_VESSEIL_TYPE]: 'Energy Vesseil',
            [AGILITY_CAPE_TYPE]: 'Agility Cape',
            [LV1_KEY_TYPE]: 'Lv 1 Key',
            [CONNECTER_BLOCK_TYPE]: 'Connecter',
            [RED_CLOTH_TYPE]: 'Red Cloth',
            [ORANGE_CLOTH_TYPE]: 'Orange Cloth',
            [YELLOW_CLOTH_TYPE]: 'Yellow Cloth',
            [GREEN_CLOTH_TYPE]: 'Green Cloth',
            [BLUE_CLOTH_TYPE]: 'Blue Cloth',
            [INDIGO_CLOTH_TYPE]: 'Indigo Cloth',
            [VIOLET_CLOTH_TYPE]: 'Violet Cloth',
            [RED_SCONCE_TYPE]: 'Red Sconce',
            [BLUE_SCONCE_TYPE]: 'Blue Sconce'
        };

        // push constants onto game instance so other methods can refer to them
        this.MUSKET_TYPE = MUSKET_TYPE;
        this.SLIME_TYPE = SLIME_TYPE;
        this.MAN_POSTER_TYPE = MAN_POSTER_TYPE;
        this.TNT_TYPE = TNT_TYPE;
        this.MAP_TYPE = MAP_TYPE;
        this.CAULDRON_TYPE = CAULDRON_TYPE;
        this.HEALING_POTION_TYPE = HEALING_POTION_TYPE;
        this.CHILLING_POTION_TYPE = CHILLING_POTION_TYPE;
        this.STRUCTURE_BLOCK_TYPE = STRUCTURE_BLOCK_TYPE;
        this.FAIRIA_PORTAL_BLOCK_TYPE = FAIRIA_PORTAL_BLOCK_TYPE;
        this.WOOD_DOOR_TYPE = WOOD_DOOR_TYPE;
        this.DUNGEON_DOOR_TYPE = DUNGEON_DOOR_TYPE;
        this.ASTARA_SCROLL_TYPE = ASTARA_SCROLL_TYPE;
        this.CLOUTUMP_SCROLL_TYPE = CLOUTUMP_SCROLL_TYPE;
        this.RUNE_OF_BATTER_TYPE = RUNE_OF_BATTER_TYPE;
        this.LIFE_CONTANER_TYPE = LIFE_CONTANER_TYPE;
        this.ENERGY_VESSEIL_TYPE = ENERGY_VESSEIL_TYPE;
        this.AGILITY_CAPE_TYPE = AGILITY_CAPE_TYPE;
        this.LV1_KEY_TYPE = LV1_KEY_TYPE;
        this.CONNECTER_BLOCK_TYPE = CONNECTER_BLOCK_TYPE;
        this.RED_CLOTH_TYPE = RED_CLOTH_TYPE;
        this.ORANGE_CLOTH_TYPE = ORANGE_CLOTH_TYPE;
        this.YELLOW_CLOTH_TYPE = YELLOW_CLOTH_TYPE;
        this.GREEN_CLOTH_TYPE = GREEN_CLOTH_TYPE;
        this.BLUE_CLOTH_TYPE = BLUE_CLOTH_TYPE;
        this.INDIGO_CLOTH_TYPE = INDIGO_CLOTH_TYPE;
        this.VIOLET_CLOTH_TYPE = VIOLET_CLOTH_TYPE;
        this.RED_SCONCE_TYPE = RED_SCONCE_TYPE;
        this.BLUE_SCONCE_TYPE = BLUE_SCONCE_TYPE;
        // Structure-block corner tracking (in-game structure editor)
        this.structureCorner1 = null;
        this.structureCorner2 = null;
        
        // Lair system - hierarchical organization of items
        this.lairs = {
            'Stone': {
                name: 'Stone',
                description: 'Stone-based lairs and items',
                items: [],
                children: {
                    'Grim Stone': {
                        name: 'Grim Stone',
                        description: 'Grim Stone lair - dark and foreboding',
                        items: []
                    }
                }
            }
        };
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        const savedFogEnabled = localStorage.getItem('fogEnabled');
        const fogEnabled = savedFogEnabled === null ? true : savedFogEnabled !== 'false';
        const fogDensityRaw = parseFloat(localStorage.getItem('fogDensity'));
        const density = Number.isFinite(fogDensityRaw) ? Math.min(Math.max(fogDensityRaw, 0.0), 0.05) : 0.01; // clamp to sane range
        // Use exponential fog for a stronger, more obvious effect
        this.scene.fog = fogEnabled ? new THREE.FogExp2(0x87CEEB, density) : null;

        // Use saved FOV or default to 90
        const fov = parseFloat(localStorage.getItem('fov')) || 90;
        this.camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 1000);
        
        console.log('Creating renderer...');
        // Check if WebGL is supported
        if (!window.WebGLRenderingContext) {
            throw new Error('WebGL is not supported by your browser.');
        }
        // Validate canvas container dimensions
        const container = document.getElementById('canvas-container');
        if (container && (container.clientWidth === 0 || container.clientHeight === 0)) {
            console.warn('Canvas container has zero dimensions:', container.clientWidth, 'x', container.clientHeight);
        }
        console.log('Canvas container dimensions:', container ? (container.clientWidth + 'x' + container.clientHeight) : 'not found');
        console.log('Window dimensions:', window.innerWidth, 'x', window.innerHeight);
        
        // Attempt to create a WebGL2 renderer first; some GPUs/drivers throw when compiling
        // the depth/shadow shaders.  If a compile error occurs, fall back to WebGL1.
        let useWebGL1 = false;
        const rendererOptions = { antialias: true, failIfMajorPerformanceCaveat: false };
        try {
            this.renderer = new THREE.WebGLRenderer(rendererOptions);
            if (this.renderer.capabilities.isWebGL2) {
                // create a tiny mesh with depth material to force a compile
                const testMat = new THREE.MeshDepthMaterial();
                const testGeo = new THREE.BufferGeometry();
                testGeo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0], 3));
                const testMesh = new THREE.Mesh(testGeo, testMat);
                const testScene = new THREE.Scene();
                testScene.add(testMesh);
                const testCam = new THREE.PerspectiveCamera();
                // render to offscreen to trigger shader compilation
                this.renderer.render(testScene, testCam);
            }
        } catch (err) {
            console.warn('WebGL2 initialization failed, falling back to WebGL1:', err);
            useWebGL1 = true;
        }
        if (useWebGL1) {
            this.renderer = new THREE.WebGL1Renderer(rendererOptions);
        }

        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        // enable shadows only if the context successfully compiled earlier
        try {
            this.renderer.shadowMap.enabled = true;
        } catch (e) {
            console.warn('Failed to enable shadow maps, disabling them.', e);
            this.renderer.shadowMap.enabled = false;
        }
        
        console.log('Container element:', container);
        
        if (!container) {
            console.error('canvas-container not found!');
            return;
        }
        // Attach renderer canvas to DOM so it's visible
        try {
            // Ensure canvas fills the container
            this.renderer.domElement.style.display = 'block';
            this.renderer.domElement.style.width = '100%';
            this.renderer.domElement.style.height = '100%';
            container.appendChild(this.renderer.domElement);
        } catch (e) {
            console.warn('Failed to append renderer DOM element:', e);
        }
        
        // Directional sun light
        this.sunLight = new THREE.DirectionalLight(0xFFFFFF, 1.8);
        this.sunLight.position.set(100, 100, 100);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.camera.left = -200;
        this.sunLight.shadow.camera.right = 200;
        this.sunLight.shadow.camera.top = 200;
        this.sunLight.shadow.camera.bottom = -200;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.scene.add(this.sunLight);

        // Visible sun sphere in the sky
        const sunGeo = new THREE.SphereGeometry(18, 16, 16);
        const sunMat = new THREE.MeshBasicMaterial({ color: 0xFFFDE0, fog: false });
        this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
        this.scene.add(this.sunMesh);

        // Visible moon sphere (opposite side of sky from sun)
        const moonGeo = new THREE.SphereGeometry(13, 16, 16);
        const moonMat = new THREE.MeshBasicMaterial({ color: 0xDDDFFF, fog: false });
        this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
        this.scene.add(this.moonMesh);
        this.createWeatherLayer();
        this.createAuroraLayer();
        this.createCloudLayer();
        // Single block highlight — shown only on the block the player is looking at
        const hlEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
        this.blockHighlight = new THREE.LineSegments(
            hlEdges,
            new THREE.LineBasicMaterial({ color: 0x000000, depthTest: true })
        );
        this.blockHighlight.visible = false;
        this.scene.add(this.blockHighlight);

        this.ambientLight = new THREE.AmbientLight(0xFFFFFF, 1.2);
        this.scene.add(this.ambientLight);
        // Astral dimension: boost ambient and sun light for a brighter look
        if (this.world && this.world.worldType === 'astral') {
            this.ambientLight.intensity = 1.2;
            this.sunLight.intensity = 1.1;
        }
        
        // Day/night cycle
        this.dayTime = 0.25; // Start at dawn (0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset, 1.0=midnight)
        this.dayLength = 3600; // Full day cycle in seconds (60 minutes: 15 mins per quarter)
        this.freezeLighting = false; // Allow the sun to move (continuous cycle)

        console.log('Loading texture atlas...');
        this.textureAtlas = null;
        this.loadTextureAtlas();

        console.log('Creating world... (type:', worldType + ', multiplayer:', isMultiplayer, ', team:', team, ', survival:', survivalMode + ')');
        this.world = new VoxelWorld(worldType);
        this.isMultiplayer = !!isMultiplayer;
        this.team = team === 'blue' ? 'blue' : 'red';
        this.mesher = null; // Will be created after texture loads
        // chat state
        this.chatLogEl = null;
        this.chatInputEl = null;
        this.chatActive = false;
        this.hudHidden = false;
        this.chatHistory = [];  // Store sent messages for history recall
        this.chatHistoryIndex = -1;  // Current position in history (-1 = not in history)
        this.player = new Player(survivalMode);
        this.player.gameInstance = this; // Reference to game for curse effects
        // weapon visuals bookkeeping
        this.currentHandWeaponType = null;
        this.currentPlayerWeaponType = null;
        this.otherPlayerWeaponType = null;
        this.handWeaponMesh = null;
        this.playerModelWeapon = null;
        this.otherPlayerWeaponMesh = null;
        const initialSpawn = this.getSafeSpawnPositionNear(0, 0, 4);
        this.player.position.copy(initialSpawn);

        // Player model color: use custom color if provided, otherwise team color
        if (this.customPlayerColor) {
            this.playerColor = parseInt(this.customPlayerColor.replace('#', '0x'));
        } else {
            this.playerColor = this.team === 'blue' ? 0x3333ff : 0xff3333;
        }
        // Create a visible player model in the world
        this.createPlayerModel();

        // Hostile mobs
        this.pigmen = [];
        this.slimes = []; // teal transparent mobs with grey eyes
        this.sacculariusMoles = [];
        this.lastMoleSpawnRollTime = 0;
        this.squirrels = []; // cute and harmless creatures
        this.testSalesmen = null; // singleton NPC per world
        // Active projectiles fired by muskets (or other future weapons)
        this.projectiles = [];
        // Force-spawn pigmen (and slimes) nearby to guarantee they appear
        setTimeout(() => {
            console.log('[Init] Force-spawning pigmen and slimes after world ready...');
            console.log('[Init] Scene exists:', !!this.scene, 'Player pos:', this.player.position.x, this.player.position.y, this.player.position.z);
            
            if (!this.scene) {
                console.error('[Init] Scene not ready! Cannot spawn pigmen.');
                return;
            }
            
            for (let i = 0; i < 3; i++) {
                const angle = (Math.PI * 2 / 3) * i;
                const radius = 5 + Math.random() * 3;
                const px = this.player.position.x + Math.cos(angle) * radius;
                const py = this.player.position.y;
                const pz = this.player.position.z + Math.sin(angle) * radius;
                
                console.log(`[Init] Attempting piggron spawn ${i + 1} at (${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)})`);
                const pig = this.spawnpiggronAtExact(px, py, pz);
                console.log(`[Init] piggron spawn ${i + 1} result:`, pig ? 'SUCCESS' : 'FAILED');

                // also spawn a slime nearby for variety
                const sangle = Math.random() * Math.PI * 2;
                const sradius = 5 + Math.random() * 3;
                const sx = this.player.position.x + Math.cos(sangle) * sradius;
                const sy = py;
                const sz = this.player.position.z + Math.sin(sangle) * sradius;
                console.log(`[Init] Attempting slime spawn ${i + 1} at (${sx.toFixed(1)}, ${sy.toFixed(1)}, ${sz.toFixed(1)})`);
                const slime = this.spawnSlimeAtExact ? this.spawnSlimeAtExact(sx, sy, sz) : null;
                console.log(`[Init] Slime spawn ${i + 1} result:`, slime ? 'SUCCESS' : 'FAILED');

                // Also spawn a squirrel for variety
                const squangle = Math.random() * Math.PI * 2;
                const sqradius = 6 + Math.random() * 2;
                const sqx = this.player.position.x + Math.cos(squangle) * sqradius;
                const sqy = py;
                const sqz = this.player.position.z + Math.sin(squangle) * sqradius;
                console.log(`[Init] Attempting squirrel spawn ${i + 1} at (${sqx.toFixed(1)}, ${sqy.toFixed(1)}, ${sqz.toFixed(1)})`);
                const squirrel = this.spawnSquirrelAtExact ? this.spawnSquirrelAtExact(sqx, sqy, sqz) : null;
                console.log(`[Init] Squirrel spawn ${i + 1} result:`, squirrel ? 'SUCCESS' : 'FAILED');
            }
            console.log(`[Init] Total pigmen after force-spawn: ${this.pigmen.length}, slimes: ${this.slimes.length}, squirrels: ${this.squirrels.length}`);
        }, 1500);
        this.piggronPriest = null; // Boss mob
        this.minutors = [];
        this.spawnMinutors(2); // Spawn 2 Minutors in the maze
        
        // Mount
        this.phinox = null;
        this.isMountedOnPhinox = false;

        // If multiplayer, create a second player (local bot placeholder)
        if (this.isMultiplayer) {
            this.createOtherPlayer(this.team === 'blue' ? 'red' : 'blue');
        }
        // Third-person camera state
        this.thirdPerson = false;
        this.thirdPersonDistance = 4.0;
        this.thirdCamera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 1000);

        // Hotbar selection index (0..7)
        this.hotbarIndex = 0;

        // Debug mode: when true, render simple Box meshes per visible block (slow)
        this.debugMode = true;

        this.chunkMeshes = new Map();
        this.chunkBounds = new Map(); // Map of chunk key -> bounding sphere for frustum culling
        this.chunkMeshQueue = []; // Queue of {cx,cz} to generate
        this.generatingChunkMesh = false; // Flag to process one per frame
        this.torchLights = new Map(); // Map of 'x,y,z' -> THREE.PointLight for torches
        this.lastTorchRebuildTime = 0; // Throttle torch rebuilds
        this.useRuntimeTorchLights = false; // Disable dynamic PointLight torches in favor of lightmaps
        this.sconceSmokeParticles = [];
        this.sconceEmitters = [];
        this.lastSconceEmitterRebuildTime = 0;
        this.sconceSmokeSpawnAccumulator = 0;
        this.sconceSmokeTexture = null;
        this.chestStorage = new Map(); // Map of 'x,y,z' -> [20 slots] for chest inventory
        this.lockedChests = new Map(); // Map of 'x,y,z' -> { keyLevel }
        this.cathedralLockedChestKey = null;
        this.openChestPos = null; // Currently open chest position as 'x,y,z'
        this.candleStorage = new Map(); // Map of 'x,y,z' -> [3 slots] for magic candles
        this.opencandlePos = null; // Currently open candle position
        this.cauldronStorage = new Map(); // Map of 'x,y,z' -> [3 slots] for potion brewing
        this.openCauldronPos = null;
        this.connectorData = new Map(); // Map of 'x,y,z' -> { code, dir, letter }
        this.pendingConnectorData = null; // Set through connector UI before placement
        this.paintings = []; // [{mesh, backX, backY, backZ}] — placed Man Poster paintings
        this.woodDoors = []; // [{mesh, backX, backY, backZ, posX, posY, posZ, rotY}]
        this.dungeonDoors = []; // [{mesh, backX, backY, backZ, posX, posY, posZ, rotY}]
        this.manPosterTexture = null; // loaded in loadTextureAtlas
        this.woodDoorTexture = null; // loaded in loadTextureAtlas
        this.dungeonDoorTexture = null; // loaded in loadTextureAtlas
        this.primedTNT = new Map(); // key -> {x,y,z,mesh,startMs}
        this._testSalesmenShopEl = null;

        // Minimap UI (shown when Map accessory is equipped)
        const minimapWrap = document.createElement('div');
        minimapWrap.style.cssText = 'position:fixed;top:16px;right:16px;width:208px;background:#0a0a0a;border:2px solid #555;border-radius:6px;z-index:50;display:none;padding:4px;box-sizing:border-box;';
        const minimapTitle = document.createElement('div');
        minimapTitle.textContent = 'Map';
        minimapTitle.style.cssText = 'color:#fff;font:bold 11px monospace;text-align:center;margin-bottom:2px;letter-spacing:1px;';
        minimapWrap.appendChild(minimapTitle);
        const minimapCanvas = document.createElement('canvas');
        minimapCanvas.width = 200;
        minimapCanvas.height = 200;
        minimapCanvas.style.cssText = 'display:block;width:200px;height:200px;';
        minimapWrap.appendChild(minimapCanvas);
        document.body.appendChild(minimapWrap);
        this._minimapEl = minimapWrap;
        this._minimapCanvas = minimapCanvas;
        this._minimapFrame = 0;
        this.discoveredChunks = {
            default: new Set(),
            fairia: new Set(),
            astral: new Set()
        };
        this.mapWaypoints = {
            default: [],
            fairia: [],
            astral: []
        };
        this.pendingBreak = null; // Track pending delayed block break
        this.crosshairProgress = 0; // Last rendered crosshair fill
        this.inAstralDimension = false; // Are we in the astral dimension?
        this.astralReturnState = null; // Saved overworld state when entering astral
        this.inFairiaDimension = false; // Are we in the fairia dimension?
        this.fairiaReturnState = null; // Saved state when entering fairia
        this.lastFairiaHeatDamageTime = 0;
        this.portalTouchCooldownUntil = 0;
        this.chillProtectionUntil = 0;
        this._heatPopupTimeout = null;
        this.weatherState = 'clear';
        this.lastWeatherRollNight = -1;
        this.wasInNightWindow = false;
        this.renderDistance = 3;
        this.blindnessEndTime = 0; // Timestamp when blindness effect ends

        this.clock = new THREE.Clock();
        this.lastFrameTime = 0;
        this.frameCount = 0;
        this.fps = 0;

        this.selectedBlock = null;
        this.selectedFace = null;

        console.log('Setting up input...');
        this.setupInput();
        
        // Chat UI (must be created after input so slash key works)
        this.createChatUI();
        
        // Initialize hotbar based on game mode
        this.initializeHotbar();
        
        console.log('Creating hand block...');
        this.handBlock = null;
        
        // Create HP/AP bars if survival mode
        if (this.survivalMode) {
            this.createHealthBar();
            this.createAPBar();
            this.createMPBar();
            this.createXPBar();
            this.createGoldDisplay();
            this.updateHealthBar();
            this.updateAPBar();
            this.updateMPBar();
            this.updateXPBar();
            this.updateGoldDisplay();
        }

        // (music removed)

        // Request pointer lock immediately for easier control
        setTimeout(() => {
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && typeof el.requestPointerLock === 'function') {
                    el.requestPointerLock();
                }
            } catch (e) {
                console.warn('Auto pointer lock request failed', e);
            }
        }, 500);
        
        console.log('Starting animation loop...');
        this.animate();
    }

    // Connect to an online WebSocket server. By default this uses native WebSocket.
    // Set `forceSocketIO` to true to use Socket.IO instead (only if `io` is available).
    connectServer(host = 'localhost', port = 8080, password = '', forceSocketIO = false) {
        try {
            // store password for hello packet and possible reconnects
            this.serverPassword = password || '';
            this.remotePlayers = new Map(); // {id -> {x,y,z,yaw,name,team}}
            this.remotePlayerModels = new Map(); // {id -> THREE.Group}

            // If caller explicitly requests Socket.IO and the client lib is present, use it.
            if (forceSocketIO && typeof io !== 'undefined') {
                const url = `http://${host}:${port}`;
                console.log('Connecting to server (socket.io):', url);
                this.socket = io(url);

                // Provide a ws-like send wrapper so existing code can call this.ws.send(...)
                this.ws = {
                    readyState: 1,
                    send: (data) => {
                        try {
                            const parsed = JSON.parse(data);
                            this.socket.emit('raw', parsed);
                        } catch (e) {
                            this.socket.emit('raw', data);
                        }
                    }
                };

                this.socket.on('raw', (m) => {
                    try {
                        switch (m.type) {
                            case 'welcome':
                                for (const p of m.players || []) {
                                    if (p.id !== m.id) { this.remotePlayers.set(p.id, p); this.createRemotePlayerModel(p); }
                                }
                                break;
                            case 'error':
                                if (m.text) this.addChatMessage(`Server: ${m.text}`);
                                break;
                            case 'join':
                                if (m.player && !this.remotePlayers.has(m.player.id)) { this.addChatMessage(`${m.player.name} connected`); this.remotePlayers.set(m.player.id, m.player); this.createRemotePlayerModel(m.player); }
                                break;
                            case 'leave':
                                if (m.id) { const p = this.remotePlayers.get(m.id); const name = p ? p.name : `Player${m.id}`; this.addChatMessage(`${name} disconnected`); this.remotePlayers.delete(m.id); this.removeRemotePlayerModel(m.id); }
                                break;
                            case 'state':
                                if (m.id) { const p = this.remotePlayers.get(m.id) || { id: m.id }; p.x = m.x; p.y = m.y; p.z = m.z; p.yaw = m.yaw; this.remotePlayers.set(m.id, p); }
                                break;
                            case 'blockChange':
                                if (m.x !== undefined && m.y !== undefined && m.z !== undefined && m.blockType !== undefined) {
                                    this.world.setBlock(m.x, m.y, m.z, m.blockType);
                                    const cx = Math.floor(m.x / this.world.chunkSize);
                                    const cz = Math.floor(m.z / this.world.chunkSize);
                                    this.updateChunkMesh(cx, cz);
                                    if (m.x % this.world.chunkSize === 0) this.updateChunkMesh(cx - 1, cz);
                                    if (m.z % this.world.chunkSize === 0) this.updateChunkMesh(cx, cz - 1);
                                }
                                break;
                            case 'chat':
                                if (m.name && m.text) this.addChatMessage(`${m.name}: ${m.text}`);
                                break;
                        }
                    } catch (e) { console.warn('Bad server message', e); }
                });

                this.socket.on('connect', () => {
                    console.log('Connected to server (socket.io)');
                    this.socket.emit('raw', { type: 'hello', name: this.playerName, team: this.team, password: this.serverPassword });
                });

                this.socket.on('disconnect', () => {
                    console.log('Disconnected from server (socket.io)');
                    for (const id of this.remotePlayerModels.keys()) this.removeRemotePlayerModel(id);
                });

                return;
            }

            // Default: native WebSocket
            const url = `ws://${host}:${port}`;
            console.log('Connecting to server:', url);
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                console.log('Connected to server');
                // Send hello with player info (include password if provided)
                try {
                    this.ws.send(JSON.stringify({ type: 'hello', name: this.playerName, team: this.team, password: this.serverPassword }));
                } catch {}
            };

            this.ws.onmessage = (evt) => {
                try {
                    const msg = JSON.parse(evt.data);
                    switch (msg.type) {
                        case 'welcome':
                            // Sync existing players
                            for (const p of msg.players || []) {
                                if (p.id !== msg.id) { // Don't render ourselves
                                    this.remotePlayers.set(p.id, p);
                                    this.createRemotePlayerModel(p);
                                }
                            }
                            break;
                        case 'error':
                            // display server-side errors as chat so user sees them
                            if (msg.text) {
                                this.addChatMessage(`Server: ${msg.text}`);
                            }
                            break;
                        case 'join':
                            if (msg.player && !this.remotePlayers.has(msg.player.id)) {
                                this.addChatMessage(`${msg.player.name} connected`);
                                this.remotePlayers.set(msg.player.id, msg.player);
                                this.createRemotePlayerModel(msg.player);
                            }
                            break;
                        case 'leave':
                            if (msg.id) {
                                const p = this.remotePlayers.get(msg.id);
                                const name = p ? p.name : `Player${msg.id}`;
                                this.addChatMessage(`${name} disconnected`);
                                this.remotePlayers.delete(msg.id);
                                this.removeRemotePlayerModel(msg.id);
                            }
                            break;
                        case 'state':
                            if (msg.id) {
                                const p = this.remotePlayers.get(msg.id) || { id: msg.id };
                                p.x = msg.x; p.y = msg.y; p.z = msg.z; p.yaw = msg.yaw;
                                this.remotePlayers.set(msg.id, p);
                            }
                            break;
                        case 'blockChange':
                            // Apply block changes from other players
                            if (msg.x !== undefined && msg.y !== undefined && msg.z !== undefined && msg.blockType !== undefined) {
                                this.world.setBlock(msg.x, msg.y, msg.z, msg.blockType);
                                const cx = Math.floor(msg.x / this.world.chunkSize);
                                const cz = Math.floor(msg.z / this.world.chunkSize);
                                this.updateChunkMesh(cx, cz);
                                // Update adjacent chunks if on edge
                                if (msg.x % this.world.chunkSize === 0) this.updateChunkMesh(cx - 1, cz);
                                if (msg.z % this.world.chunkSize === 0) this.updateChunkMesh(cx, cz - 1);
                            }
                            break;
                        case 'chat':
                            if (msg.name && msg.text) {
                                this.addChatMessage(`${msg.name}: ${msg.text}`);
                            }
                            break;
                        default:
                            break;
                    }
                } catch (e) {
                    console.warn('Bad server message', e);
                }
            };

            this.ws.onclose = () => {
                console.log('Disconnected from server');
                // Clean up all remote player models
                for (const id of this.remotePlayerModels.keys()) {
                    this.removeRemotePlayerModel(id);
                }
            };
        } catch (e) {
            console.error('Failed to connect to server', e);
        }
    }

    createRemotePlayerModel(playerData) {
        if (!playerData || this.remotePlayerModels.has(playerData.id)) return;

        const group = new THREE.Group();
        // Use piggron texture if available, otherwise use team color
        const material = this.piggronTexture ?
            new THREE.MeshLambertMaterial({ map: this.piggronTexture }) :
            new THREE.MeshLambertMaterial({ color: playerData.team === 'blue' ? 0x3333ff : 0xff3333 });

        // Torso
        const torsoGeo = new THREE.BoxGeometry(0.6, 1.0, 0.4);
        const torso = new THREE.Mesh(torsoGeo, material);
        torso.castShadow = true;
        group.add(torso);

        // Head
        const headGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
        const head = new THREE.Mesh(headGeo, material);
        head.position.y = 0.9;
        head.castShadow = true;
        group.add(head);

        // Legs
        const legsGeo = new THREE.BoxGeometry(0.6, 0.8, 0.35);
        const legs = new THREE.Mesh(legsGeo, material);
        legs.position.y = -0.9;
        legs.castShadow = true;
        group.add(legs);

        // Name label
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'Bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(playerData.name || 'Player', 128, 45);
        
        const nameTexture = new THREE.CanvasTexture(canvas);
        const nameMaterial = new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true });
        const nameGeo = new THREE.PlaneGeometry(1.5, 0.4);
        const nameLabel = new THREE.Mesh(nameGeo, nameMaterial);
        nameLabel.position.y = 1.5;
        nameLabel.userData.isNameLabel = true;
        group.add(nameLabel);

        group.position.set(playerData.x || 0, playerData.y || 70, playerData.z || 0);
        group.rotation.y = playerData.yaw || 0;

        this.scene.add(group);
        this.remotePlayerModels.set(playerData.id, group);
    }

    removeRemotePlayerModel(id) {
        const model = this.remotePlayerModels.get(id);
        if (model) {
            this.scene.remove(model);
            this.remotePlayerModels.delete(id);
        }
    }

    loadTextureAtlas() {
        // Load individual block textures and composite them into an atlas
        const textureLoader = new THREE.TextureLoader();
        const blockTextures = new Map();
        
        // List of block textures to load (maps to atlas grid position)
        const textureMap = {
            'dirt': { x: 0, y: 0 },
            'grass': { x: 1, y: 0 },
            'stone': { x: 2, y: 0 },
            'sand': { x: 3, y: 0 },
            'water': { x: 0, y: 1 },
            'wood': { x: 1, y: 1 },
            'bricks': { x: 2, y: 1 },
            'ruby': { x: 3, y: 1 },
            'clay': { x: 0, y: 2 },
            'snow': { x: 1, y: 2 },
            'leafs': { x: 2, y: 2 },
            'sapphire': { x: 3, y: 2 },
            'coal': { x: 0, y: 3 },
            'torch': { x: 1, y: 3 },
            'plank': { x: 2, y: 3 }
        };
        
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        
        let loadedCount = 0;
        const totalTextures = Object.keys(textureMap).length;
        
        const finishLoading = () => {
            console.log(`Composited ${loadedCount}/${totalTextures} textures into atlas`);
            
            // Draw Structure Block tile at atlas position (3,3) — distinctive purple/magenta
            {
                const ts = 64, bx = 3 * ts, by = 3 * ts;
                ctx.save();
                ctx.fillStyle = '#3a006a';
                ctx.fillRect(bx, by, ts, ts);
                ctx.fillStyle = '#aa00ff';
                for (let gx = 0; gx < 4; gx++) {
                    for (let gy = 0; gy < 4; gy++) {
                        if ((gx + gy) % 2 === 0) ctx.fillRect(bx + gx * 16, by + gy * 16, 16, 16);
                    }
                }
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 36px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('S', bx + 32, by + 34);
                ctx.restore();
            }

            // Create atlas texture from canvas
            const atlasTexture = new THREE.CanvasTexture(canvas);
            atlasTexture.magFilter = THREE.NearestFilter;
            atlasTexture.minFilter = THREE.NearestFilter;
            atlasTexture.anisotropy = 1;
            this.textureAtlas = atlasTexture;
            
            // Load man_poster.png for the Man Poster painting
            textureLoader.load(
                'man_poster.png',
                (texture) => {
                    texture.magFilter = THREE.NearestFilter;
                    texture.minFilter = THREE.NearestFilter;
                    this.manPosterTexture = texture;
                    console.log('man_poster texture loaded successfully');
                },
                undefined,
                () => {
                    // Fallback: simple colored canvas poster
                    const fc = document.createElement('canvas');
                    fc.width = 64; fc.height = 128;
                    const fctx = fc.getContext('2d');
                    fctx.fillStyle = '#c8a87a';
                    fctx.fillRect(0, 0, 64, 128);
                    fctx.fillStyle = '#5a3a1a';
                    fctx.strokeStyle = '#5a3a1a';
                    fctx.lineWidth = 4;
                    fctx.strokeRect(4, 4, 56, 120);
                    fctx.fillStyle = '#a0724a';
                    fctx.fillRect(20, 20, 24, 40); // figure silhouette
                    this.manPosterTexture = new THREE.CanvasTexture(fc);
                    this.manPosterTexture.magFilter = THREE.NearestFilter;
                    this.manPosterTexture.minFilter = THREE.NearestFilter;
                }
            );

            // Load wood door texture
            textureLoader.load(
                'wood_door.png',
                (texture) => {
                    texture.magFilter = THREE.NearestFilter;
                    texture.minFilter = THREE.NearestFilter;
                    this.woodDoorTexture = texture;
                },
                undefined,
                () => {
                    const fc = document.createElement('canvas');
                    fc.width = 64; fc.height = 64;
                    const fctx = fc.getContext('2d');
                    fctx.fillStyle = '#8B4513';
                    fctx.fillRect(0, 0, 64, 64);
                    fctx.strokeStyle = '#5a3010';
                    fctx.lineWidth = 3;
                    fctx.strokeRect(4, 4, 56, 56);
                    this.woodDoorTexture = new THREE.CanvasTexture(fc);
                    this.woodDoorTexture.magFilter = THREE.NearestFilter;
                    this.woodDoorTexture.minFilter = THREE.NearestFilter;
                }
            );
            // Load dungeon door texture
            textureLoader.load(
                'ruby.png',
                (texture) => {
                    texture.magFilter = THREE.NearestFilter;
                    texture.minFilter = THREE.NearestFilter;
                    this.dungeonDoorTexture = texture;
                },
                undefined,
                () => {
                    const fc = document.createElement('canvas');
                    fc.width = 64; fc.height = 64;
                    const fctx = fc.getContext('2d');
                    fctx.fillStyle = '#CC0000';
                    fctx.fillRect(0, 0, 64, 64);
                    fctx.strokeStyle = '#880000';
                    fctx.lineWidth = 3;
                    fctx.strokeRect(4, 4, 56, 56);
                    this.dungeonDoorTexture = new THREE.CanvasTexture(fc);
                    this.dungeonDoorTexture.magFilter = THREE.NearestFilter;
                    this.dungeonDoorTexture.minFilter = THREE.NearestFilter;
                }
            );
            // Load piggron texture separately for character skins
            textureLoader.load(
                'piggron.png',
                (texture) => {
                    texture.magFilter = THREE.NearestFilter;
                    texture.minFilter = THREE.NearestFilter;
                    this.piggronTexture = texture;
                    console.log('piggron texture loaded successfully');
                },
                undefined,
                (error) => {
                    console.warn('Failed to load piggron texture:', error);
                    // Create fallback colored canvas for piggron
                    const fallbackCanvas = document.createElement('canvas');
                    fallbackCanvas.width = 64;
                    fallbackCanvas.height = 64;
                    const fallbackCtx = fallbackCanvas.getContext('2d');
                    fallbackCtx.fillStyle = '#d28a7c'; // piggron skin color
                    fallbackCtx.fillRect(0, 0, 64, 64);
                    this.piggronTexture = new THREE.CanvasTexture(fallbackCanvas);
                    this.piggronTexture.magFilter = THREE.NearestFilter;
                    this.piggronTexture.minFilter = THREE.NearestFilter;
                }
            );
            
            // Load piggron 3D model
            if (typeof THREE.GLTFLoader !== 'undefined') {
                const gltfLoader = new THREE.GLTFLoader();
                gltfLoader.load(
                    'geo.gltf',
                    (gltf) => {
                        this.piggronModelTemplate = gltf.scene;
                        console.log('✓ piggron model (geo.gltf) loaded successfully');
                        console.log('  Model scene:', gltf.scene);
                        console.log('  Children:', gltf.scene.children.length);
                    },
                    (progress) => {
                        console.log('Model loading progress:', Math.round(progress.loaded / progress.total * 100) + '%');
                    },
                    (error) => {
                        console.error('✗ Failed to load piggron model (geo.gltf):', error);
                        this.piggronModelTemplate = null; // Will fall back to box geometry
                    }
                );
            } else {
                console.warn('GLTFLoader not available - pigmen will use box geometry');
                this.piggronModelTemplate = null;
            }
            
            // Create mesher with composite atlas
            this.mesher = new BlockMesher(this.world, this.textureAtlas);
            
            // Create item manager
            this.itemManager = new ItemManager(this.scene, this.world, this.textureAtlas, this.blockNames);
            
            // Create hand block after mesher is ready
            this.createHandBlock();
            
            // Generate initial chunks
            console.log('Generating initial chunks...');
            this.generateInitialChunks();
        };
        
        // Load each texture and composite into canvas
        Object.entries(textureMap).forEach(([filename, pos]) => {
            textureLoader.load(
                `${filename}.png`,
                (texture) => {
                    // Draw the loaded image to canvas at correct position
                    const canvas2d = document.createElement('canvas');
                    canvas2d.width = texture.image.width;
                    canvas2d.height = texture.image.height;
                    const ctx2d = canvas2d.getContext('2d');
                    ctx2d.drawImage(texture.image, 0, 0);
                    
                    // Scale and place in atlas grid (64x64 per tile in 256x256 = 4x4 grid)
                    const tileSize = 64;
                    const x = pos.x * tileSize;
                    const y = pos.y * tileSize;
                    ctx.drawImage(canvas2d, x, y, tileSize, tileSize);
                    
                    loadedCount++;
                    console.log(`Composited texture: ${filename}.png (${loadedCount}/${totalTextures})`);
                    
                    if (loadedCount === totalTextures) {
                        finishLoading();
                    }
                },
                undefined,
                (error) => {
                    console.warn(`Failed to load texture: ${filename}.png`, error);
                    // Create fallback colored square
                    const colors = {
                        'dirt': '#8B4513',
                        'grass': '#228B22',
                        'stone': '#808080',
                        'sand': '#F4D03F',
                        'water': '#0099FF',
                        'wood': '#CD853F',
                        'bricks': '#A0523D',
                        'ruby': '#E81828',
                        'clay': '#D4623D',
                        'snow': '#F0F8FF',
                        'leafs': '#228B22',
                        'sapphire': '#0047AB',
                        'coal': '#2c2c2c',
                        'torch': '#FFD700'
                    };
                    
                    const tileSize = 64;
                    const x = pos.x * tileSize;
                    const y = pos.y * tileSize;
                    ctx.fillStyle = colors[filename] || '#CCCCCC';
                    ctx.fillRect(x, y, tileSize, tileSize);
                    
                    loadedCount++;
                    if (loadedCount === totalTextures) {
                        finishLoading();
                    }
                }
            );
        });
    }

    createHandBlock() {
        if (!this.textureAtlas || !this.mesher) return;
        
        // Remove old hand block if exists
        if (this.handBlock) {
            this.scene.remove(this.handBlock);
        }
        
        // Create a small cube (0.3 units)
        const geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        const material = new THREE.MeshLambertMaterial({
            map: this.textureAtlas,
            side: THREE.DoubleSide
        });
        
        this.handBlock = new THREE.Mesh(geometry, material);
        this.handBlock.position.set(0.5, -0.5, -1.2); // Bottom right of view
        this.handBlock.rotation.set(0.5, 0.5, 0); // Slight rotation for 3D effect
        
        // Add to camera so it moves with view
        this.camera.add(this.handBlock);
    }

    // create simple geometries for weapons (sword or shield)
    createWeaponMesh(type) {
        const g = new THREE.Group();
        if (type === 22 || type === 32) {
            // sword blade
            const bladeLength = 0.6;
            const bladeGeo = new THREE.BoxGeometry(0.05, bladeLength, 0.02);
            const bladeColor = type === 22 ? 0x708090 : 0xFFD700;
            const bladeMat = new THREE.MeshLambertMaterial({ color: bladeColor });
            const blade = new THREE.Mesh(bladeGeo, bladeMat);
            blade.position.set(0, -bladeLength/2, 0);
            g.add(blade);
            // handle
            const handleGeo = new THREE.BoxGeometry(0.06, 0.15, 0.06);
            const handleMat = new THREE.MeshLambertMaterial({ color: 0x8B4513 });
            const handle = new THREE.Mesh(handleGeo, handleMat);
            handle.position.set(0, 0.025, 0);
            g.add(handle);
        } else if (type === 23) {
            // wood shield is square-ish
            const shieldGeo = new THREE.BoxGeometry(0.4, 0.4, 0.05);
            const shieldMat = new THREE.MeshLambertMaterial({ color: 0xDEB887 });
            const shield = new THREE.Mesh(shieldGeo, shieldMat);
            g.add(shield);
        } else if (type === this.MUSKET_TYPE) {
            // musket: long barrel with small stock
            const barrelGeo = new THREE.BoxGeometry(0.05, 0.05, 0.8);
            const barrelMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
            const barrel = new THREE.Mesh(barrelGeo, barrelMat);
            barrel.position.set(0, 0, -0.4);
            g.add(barrel);
            const stockGeo = new THREE.BoxGeometry(0.08, 0.05, 0.2);
            const stockMat = new THREE.MeshLambertMaterial({ color: 0x8B4513 });
            const stock = new THREE.Mesh(stockGeo, stockMat);
            stock.position.set(0, 0, 0.2);
            g.add(stock);
        }
        return g;
    }

    updateHandItem() {
        const equipped = this.player && this.player.equipment ? this.player.equipment.mainHand : 0;
        const type = (equipped && typeof equipped === 'object') ? equipped.type : equipped;

        if (type !== this.currentHandWeaponType) {
            // rebuild
            if (this.handWeaponMesh && this.camera) {
                this.camera.remove(this.handWeaponMesh);
                this.handWeaponMesh = null;
            }
            if (type === 22 || type === 32 || type === 23 || type === this.MUSKET_TYPE) {
                this.handWeaponMesh = this.createWeaponMesh(type);
                // position a little left/center for fists effect
                this.handWeaponMesh.position.set(0.4, -0.4, -1);
                this.handWeaponMesh.rotation.set(0.2, 0, 0);
                if (this.camera) this.camera.add(this.handWeaponMesh);
            }
            this.currentHandWeaponType = type;
        }
        // hide block cube when weapon present
        if (this.handBlock) {
            this.handBlock.visible = !(type === 22 || type === 32 || type === 23);
        }
    }

    updatePlayerWeaponModel() {
        if (!this.playerModel) return;
        const equipped = this.player && this.player.equipment ? this.player.equipment.mainHand : 0;
        const type = (equipped && typeof equipped === 'object') ? equipped.type : equipped;
        if (type !== this.currentPlayerWeaponType) {
            // remove old weapon
            if (this.playerModelWeapon) {
                this.playerModel.remove(this.playerModelWeapon);
                this.playerModelWeapon = null;
            }
            if (type === 22 || type === 32 || type === 23 || type === this.MUSKET_TYPE) {
                this.playerModelWeapon = this.createWeaponMesh(type);
                // position roughly at right side of torso
                this.playerModelWeapon.position.set(0.4, 0.0, 0.1);
                // rotate to point forward
                this.playerModelWeapon.rotation.y = -Math.PI/2;
                this.playerModel.add(this.playerModelWeapon);
            }
            this.currentPlayerWeaponType = type;
        }
    }

    updateHandBlock() {
        if (!this.handBlock) return;
        
        const blockType = this.player.selectedBlock;
        if (!blockType) return;
        
        // Get the appropriate UV coordinates for this block
        const uv = this.mesher.getBlockUVs(blockType);
        
        // Update all faces of the cube to use the correct UV
        const geometry = this.handBlock.geometry;
        const uvAttribute = geometry.getAttribute('uv');
        
        if (uvAttribute) {
            const uvArray = uvAttribute.array;
            const uvsPerFace = 4; // 4 vertices per face
            const numFaces = 6;
            
            for (let f = 0; f < numFaces; f++) {
                const baseIdx = f * uvsPerFace * 2;
                uvArray[baseIdx] = uv.minU;
                uvArray[baseIdx + 1] = uv.maxV;
                uvArray[baseIdx + 2] = uv.minU;
                uvArray[baseIdx + 3] = uv.minV;
                uvArray[baseIdx + 4] = uv.maxU;
                uvArray[baseIdx + 5] = uv.minV;
                uvArray[baseIdx + 6] = uv.maxU;
                uvArray[baseIdx + 7] = uv.maxV;
            }
            uvAttribute.needsUpdate = true;
        }
        
        // Rotate for visual effect
        this.handBlock.rotation.x += 0.01;
        this.handBlock.rotation.y += 0.02;
    }

    createPlayerModel() {
        // Simple low-poly player made from boxes
        const group = new THREE.Group();

        // Use piggron texture if available, otherwise use solid color
        let material;
        if (this.piggronTexture) {
            material = new THREE.MeshLambertMaterial({ map: this.piggronTexture });
        } else {
            material = new THREE.MeshLambertMaterial({ color: this.playerColor || 0x4477ff });
        }

        // Torso
        const torsoGeo = new THREE.BoxGeometry(0.6, 1.0, 0.4);
        const torso = new THREE.Mesh(torsoGeo, material);
        torso.position.y = 0.0;
        torso.castShadow = true;
        group.add(torso);

        // Head
        const headGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
        const head = new THREE.Mesh(headGeo, material);
        head.position.y = 0.9;
        head.castShadow = true;
        group.add(head);

        // Legs (single block for simplicity)
        const legsGeo = new THREE.BoxGeometry(0.6, 0.8, 0.35);
        const legs = new THREE.Mesh(legsGeo, material);
        legs.position.y = -0.9;
        legs.castShadow = true;
        group.add(legs);

        // Add name label above player
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Check if email is the special email and use gold color for name
        if (this.playerEmail && this.playerEmail.toLowerCase() === 'christopherwamsley@gmail.com') {
            ctx.fillStyle = '#ffd700'; // Gold
            console.log('Gold name activated for email:', this.playerEmail);
        } else {
            ctx.fillStyle = '#ffffff'; // White
            console.log('Regular name for email:', this.playerEmail);
        }
        ctx.font = 'Bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(this.playerName, 128, 45);
        
        const nameTexture = new THREE.CanvasTexture(canvas);
        const nameMaterial = new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true });
        const nameGeo = new THREE.PlaneGeometry(1.5, 0.4);
        const nameLabel = new THREE.Mesh(nameGeo, nameMaterial);
        nameLabel.position.y = 1.5;
        // Make label always face camera (updated in animate loop)
        nameLabel.userData.isNameLabel = true;
        group.add(nameLabel);

        // Place at player's starting position
        group.position.copy(this.player.position);
        group.rotation.y = this.player.yaw;

        this.scene.add(group);
        this.playerModel = group;

        // If player is named 'agare', add a cape to their model
        try {
            if (this.playerName && this.playerName.toLowerCase() === 'agare') {
                const capeWidth = 0.6;
                const capeHeight = 1.0;
                const capeGeo = new THREE.PlaneGeometry(capeWidth, capeHeight, 1, 8);
                // Pivot the plane at the top so it hangs down
                capeGeo.translate(0, -capeHeight / 2 + 0.12, 0);

                const capeMat = new THREE.MeshLambertMaterial({ color: 0x770011, side: THREE.DoubleSide });
                const cape = new THREE.Mesh(capeGeo, capeMat);
                // Position cape slightly behind the torso
                cape.position.set(0, 0.45, 0.28);
                // Make sure cape faces away from the back (flip if needed)
                cape.rotation.y = Math.PI; 
                cape.castShadow = true;
                cape.userData.isCape = true;

                // Store base positions for animation
                const posAttr = cape.geometry.getAttribute('position');
                cape.userData.basePositions = new Float32Array(posAttr.array.length);
                cape.userData.basePositions.set(posAttr.array);

                group.add(cape);
                this.playerCape = cape;
            }
        } catch (e) {
            console.warn('Failed to create cape:', e);
        }

        // If player is named 'iverstim', add floating music notes around their head
        try {
            if (this.playerName && this.playerName.toLowerCase() === 'iverstim') {
                const musicNotes = [];
                const noteCount = 5;
                const noteMaterial = new THREE.MeshLambertMaterial({ color: 0xaa44ff });
                
                for (let i = 0; i < noteCount; i++) {
                    // Create simple note shape from small boxes
                    const noteGroup = new THREE.Group();
                    
                    // Note head
                    const headGeo = new THREE.SphereGeometry(0.08, 8, 8);
                    const head = new THREE.Mesh(headGeo, noteMaterial);
                    noteGroup.add(head);
                    
                    // Note stem
                    const stemGeo = new THREE.BoxGeometry(0.03, 0.15, 0.03);
                    const stem = new THREE.Mesh(stemGeo, noteMaterial);
                    stem.position.set(0.08, 0.08, 0);
                    noteGroup.add(stem);
                    
                    // Position around head in a circle
                    const angle = (i / noteCount) * Math.PI * 2;
                    const radius = 0.5;
                    noteGroup.position.set(
                        Math.cos(angle) * radius,
                        1.5 + Math.sin(angle * 2) * 0.3,
                        Math.sin(angle) * radius
                    );
                    
                    // Store animation data
                    noteGroup.userData.isNote = true;
                    noteGroup.userData.basePos = {
                        x: noteGroup.position.x,
                        y: noteGroup.position.y,
                        z: noteGroup.position.z,
                        angle: angle
                    };
                    noteGroup.userData.time = Math.random() * Math.PI * 2;
                    
                    group.add(noteGroup);
                    musicNotes.push(noteGroup);
                }
                
                this.musicNotes = musicNotes;
            }
        } catch (e) {
            console.warn('Failed to create music notes:', e);
        }

        // If player is named 'cw', add floating hearts around their head
        try {
            if (this.playerName && this.playerName.toLowerCase() === 'cw') {
                const hearts = [];
                const heartCount = 6;
                const heartMaterial = new THREE.MeshLambertMaterial({ color: 0xff4488 });
                
                for (let i = 0; i < heartCount; i++) {
                    // Create simple heart shape from 2 spheres (lobes) and 1 cone (point)
                    const heartGroup = new THREE.Group();
                    
                    // Left lobe
                    const leftLobeGeo = new THREE.SphereGeometry(0.1, 8, 8);
                    const leftLobe = new THREE.Mesh(leftLobeGeo, heartMaterial);
                    leftLobe.position.set(-0.08, 0.05, 0);
                    heartGroup.add(leftLobe);
                    
                    // Right lobe
                    const rightLobeGeo = new THREE.SphereGeometry(0.1, 8, 8);
                    const rightLobe = new THREE.Mesh(rightLobeGeo, heartMaterial);
                    rightLobe.position.set(0.08, 0.05, 0);
                    heartGroup.add(rightLobe);
                    
                    // Bottom point (using cone)
                    const pointGeo = new THREE.ConeGeometry(0.12, 0.2, 8);
                    const point = new THREE.Mesh(pointGeo, heartMaterial);
                    point.position.set(0, -0.1, 0);
                    point.rotation.z = Math.PI;
                    heartGroup.add(point);
                    
                    // Position around head in a circle
                    const angle = (i / heartCount) * Math.PI * 2;
                    const radius = 0.6;
                    heartGroup.position.set(
                        Math.cos(angle) * radius,
                        1.5 + Math.sin(angle * 1.5) * 0.4,
                        Math.sin(angle) * radius
                    );
                    
                    // Store animation data
                    heartGroup.userData.isHeart = true;
                    heartGroup.userData.basePos = {
                        x: heartGroup.position.x,
                        y: heartGroup.position.y,
                        z: heartGroup.position.z,
                        angle: angle
                    };
                    heartGroup.userData.time = Math.random() * Math.PI * 2;
                    
                    group.add(heartGroup);
                    hearts.push(heartGroup);
                }
                
                this.hearts = hearts;
            }
        } catch (e) {
            console.warn('Failed to create hearts:', e);
        }
    }

    updatePlayerModel() {
        if (!this.playerModel || !this.player) return;
        // Keep model centered on player's world position
        this.playerModel.position.copy(this.player.position);
        // Align model yaw (rotate to face same direction as camera yaw)
        this.playerModel.rotation.y = this.player.yaw;
        
        // Update floating hearts
        if (this.hearts) {
            this.hearts.forEach(heart => {
                heart.userData.time += 0.05;
                const basePos = heart.userData.basePos;
                heart.position.x = basePos.x + Math.sin(heart.userData.time) * 0.12;
                heart.position.y = basePos.y + Math.cos(heart.userData.time * 0.7) * 0.2;
                heart.position.z = basePos.z + Math.sin(heart.userData.time * 1.1) * 0.12;
                heart.rotation.z += 0.06; // Rotate the hearts
                heart.rotation.x = Math.sin(heart.userData.time * 0.5) * 0.3;
            });
        }
        
        // Update floating music notes
        if (this.musicNotes) {
            this.musicNotes.forEach(note => {
                note.userData.time += 0.05;
                const basePos = note.userData.basePos;
                note.position.x = basePos.x + Math.sin(note.userData.time) * 0.1;
                note.position.y = basePos.y + Math.cos(note.userData.time * 0.8) * 0.15;
                note.position.z = basePos.z + Math.sin(note.userData.time * 1.2) * 0.1;
                note.rotation.z += 0.05; // Rotate the notes
            });
        }
        
        // Make name label face camera
        this.playerModel.children.forEach(child => {
            if (child.userData.isNameLabel) {
                child.lookAt(this.camera.position);
            }
        });
    }

    createOtherPlayer(team) {
        // Simple local bot placeholder for multiplayer
        const other = new Player();
        if (this.world && this.world.worldType === 'fortress') {
            const spawnY = 64 + 1.6;
            if (team === 'red') other.position.set(-10, spawnY, 8); else other.position.set(10, spawnY, -8);
        } else {
            if (team === 'red') other.position.set(-5, 70, 0); else other.position.set(5, 70, 0);
        }
        this.otherPlayer = other;

        // model
        const group = new THREE.Group();
        // Use piggron texture if available, otherwise use team color
        const material = this.piggronTexture ?
            new THREE.MeshLambertMaterial({ map: this.piggronTexture }) :
            new THREE.MeshLambertMaterial({ color: team === 'blue' ? 0x3333ff : 0xff3333 });
        const torsoGeo = new THREE.BoxGeometry(0.6, 1.0, 0.4);
        const torso = new THREE.Mesh(torsoGeo, material);
        torso.castShadow = true;
        group.add(torso);
        const headGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
        const head = new THREE.Mesh(headGeo, material);
        head.position.y = 0.9;
        group.add(head);
        
        // Add name label for other player
        const otherTeam = team === 'red' ? 'blue' : 'red';
        const otherName = otherTeam === 'red' ? 'Red Player' : 'Blue Player';
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'Bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(otherName, 128, 45);
        
        const nameTexture = new THREE.CanvasTexture(canvas);
        const nameMaterial = new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true });
        const nameGeo = new THREE.PlaneGeometry(1.5, 0.4);
        const nameLabel = new THREE.Mesh(nameGeo, nameMaterial);
        nameLabel.position.y = 1.5;
        nameLabel.userData.isNameLabel = true;
        group.add(nameLabel);
        
        group.position.copy(other.position);
        this.scene.add(group);
        this.otherPlayerModel = group;
    }

    spawnSquirrelAt(x, z) {
        if (!this.world) return null;
        let surfaceY = this.world.getTerrainHeight(Math.floor(x), Math.floor(z));
        // If below water, clamp to water surface
        if (surfaceY < this.world.waterLevel - 1) {
            surfaceY = this.world.waterLevel + 1;
        }

        const pos = new THREE.Vector3(x + 0.5, surfaceY + 0.5, z + 0.5);
        const squirrel = new Squirrel(pos, this);
        const mesh = squirrel.createMesh();
        if (mesh) this.scene.add(mesh);
        this.squirrels.push(squirrel);
        console.log(`[Spawn] Squirrel at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
        return squirrel;
    }

    ensureTestSalesmenSpawn() {
        if (!this.world || !this.scene) return;
        if (this.world.worldType !== 'default') {
            if (this.testSalesmen && this.testSalesmen.mesh) this.testSalesmen.mesh.visible = false;
            return;
        }

        if (this.testSalesmen && this.testSalesmen.mesh) {
            this.testSalesmen.mesh.visible = true;
            return;
        }

        let baseY = 69;
        try {
            const h = this.world.getTerrainHeight(0, 0);
            if (Number.isFinite(h)) baseY = h;
        } catch {}

        const spawnPos = new THREE.Vector3(0.5, baseY + 1.1, 0.5);
        const npc = new TestSalesmen(spawnPos);
        const mesh = npc.createMesh();
        if (mesh) this.scene.add(mesh);
        this.testSalesmen = npc;
    }

    isValidTestSalesmenHome(centerX, floorY, centerZ) {
        if (!this.world) return false;

        const minX = centerX - 2;
        const maxX = centerX + 2;
        const minZ = centerZ - 2;
        const maxZ = centerZ + 2;

        const isSolid = (x, y, z) => this.world.isBlockSolid(this.world.getBlock(x, y, z));

        // 5x5 solid floor
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                if (!isSolid(x, floorY, z)) return false;
            }
        }

        // 5x5 solid roof at +4 (home is 4 blocks tall)
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                if (!isSolid(x, floorY + 4, z)) return false;
            }
        }

        // Perimeter walls from +1 to +4; allow a 1x2 doorway opening (max 2 missing blocks)
        let missingWallBlocks = 0;
        for (let y = floorY + 1; y <= floorY + 4; y++) {
            for (let x = minX; x <= maxX; x++) {
                for (let z = minZ; z <= maxZ; z++) {
                    const isPerimeter = (x === minX || x === maxX || z === minZ || z === maxZ);
                    if (!isPerimeter) continue;
                    if (!isSolid(x, y, z)) {
                        if (y <= floorY + 2) {
                            missingWallBlocks++;
                            continue;
                        }
                        return false;
                    }
                }
            }
        }
        if (missingWallBlocks > 2) return false;

        // 3x3 interior clearance for standing room
        for (let y = floorY + 1; y <= floorY + 3; y++) {
            for (let x = centerX - 1; x <= centerX + 1; x++) {
                for (let z = centerZ - 1; z <= centerZ + 1; z++) {
                    if (isSolid(x, y, z)) return false;
                }
            }
        }

        return true;
    }

    findTestSalesmenHomeNear(originPos, radius = 18) {
        if (!this.world || !originPos) return null;

        const ox = Math.floor(originPos.x);
        const oy = Math.floor(originPos.y);
        const oz = Math.floor(originPos.z);
        const minY = Math.max(1, oy - 8);
        const maxY = Math.min(this.world.chunkHeight - 5, oy + 8);

        for (let y = minY; y <= maxY; y++) {
            for (let x = ox - radius; x <= ox + radius; x++) {
                for (let z = oz - radius; z <= oz + radius; z++) {
                    if (this.isValidTestSalesmenHome(x, y, z)) {
                        return {
                            x,
                            y,
                            z,
                            centerX: x + 0.5,
                            centerY: y + 1.1,
                            centerZ: z + 0.5
                        };
                    }
                }
            }
        }
        return null;
    }

    updateTestSalesmen(deltaTime) {
        this.ensureTestSalesmenSpawn();
        if (!this.testSalesmen || !this.player) return;
        this.testSalesmen.update(this.world, this.player, deltaTime, this);
    }

    hasTestSalesmenHome() {
        return !!(this.testSalesmen && this.testSalesmen.homeAnchor);
    }

    raycastTestSalesmen(maxDistance = 6) {
        if (!this.testSalesmen || !this.testSalesmen.mesh || !this.player) return null;

        const camera = this.player.getCamera();
        camera.updateMatrixWorld(true);

        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(camera.quaternion).normalize();

        const ray = new THREE.Ray(camera.position.clone(), direction);
        const hitPoint = new THREE.Vector3();

        const mesh = this.testSalesmen.mesh;
        mesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(mesh).expandByScalar(0.12);
        if (!ray.intersectBox(box, hitPoint)) return null;

        const dist = camera.position.distanceTo(hitPoint);
        if (dist > maxDistance) return null;

        return this.testSalesmen;
    }

    showTestSalesmenNoHomeDialog() {
        this.addChatMessage('[test_salesmen] I cannot trade yet. Build me a home first.');
        this.addChatMessage('[test_salesmen] Home rules: 5x5 solid floor, 5x5 solid roof at +4, perimeter walls.');
        this.addChatMessage('[test_salesmen] Leave only one 1x2 doorway, keep the inside 3x3 area clear.');
    }

    purchaseFromTestSalesmen(itemType, cost, itemName) {
        if (!this.player) return false;

        if (!this.hasTestSalesmenHome()) {
            this.showTestSalesmenNoHomeDialog();
            return false;
        }

        const currentGold = Math.max(0, Math.trunc(Number(this.player.gold) || 0));
        if (currentGold < cost) {
            this.addChatMessage(`[test_salesmen] You need ${cost} gold for ${itemName}.`);
            return false;
        }

        this.changePlayerGold(-cost, `test_salesmen:${itemName}`);
        this.addToInventory(itemType, 1);
        this.updateInventoryUI();
        this.updateHotbar();
        this.playMoneySound();

        this.addChatMessage(`[test_salesmen] Sold 1 ${itemName} for ${cost} gold.`);
        return true;
    }

    playMoneySound() {
        try {
            const snd = this.moneySound ? this.moneySound.cloneNode() : new Audio('money.mp3');
            snd.volume = this.moneySound ? this.moneySound.volume : 0.8;
            snd.play().catch(() => {});
        } catch {}
    }

    closeTestSalesmenShop() {
        if (this._testSalesmenShopEl && this._testSalesmenShopEl.parentNode) {
            this._testSalesmenShopEl.parentNode.removeChild(this._testSalesmenShopEl);
        }
        this._testSalesmenShopEl = null;
    }

    openTestSalesmenShop() {
        if (!this.hasTestSalesmenHome()) {
            this.showTestSalesmenNoHomeDialog();
            return;
        }

        this.closeTestSalesmenShop();

        const wrap = document.createElement('div');
        wrap.id = 'test-salesmen-shop';
        wrap.style.cssText = [
            'position:fixed',
            'left:50%',
            'top:50%',
            'transform:translate(-50%,-50%)',
            'background:rgba(14,18,28,0.96)',
            'border:2px solid #c45a5a',
            'border-radius:10px',
            'padding:14px',
            'z-index:1205',
            'min-width:280px',
            'color:#f3f4f8',
            'font-family:Arial,sans-serif',
            'box-shadow:0 0 24px rgba(0,0,0,0.5)'
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'test_salesmen';
        title.style.cssText = 'font-weight:bold;font-size:17px;margin-bottom:10px;color:#ff9090;';
        wrap.appendChild(title);

        const gold = document.createElement('div');
        const getGoldText = () => `Gold: ${Math.max(0, Math.trunc(Number(this.player && this.player.gold) || 0))}`;
        gold.textContent = getGoldText();
        gold.style.cssText = 'font-size:12px;margin-bottom:10px;color:#d6d9e5;';
        wrap.appendChild(gold);

        const makeBtn = (label, onClick) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.style.cssText = 'display:block;width:100%;margin:0 0 8px 0;padding:9px;border:none;border-radius:6px;background:#2f3f63;color:#fff;cursor:pointer;font-weight:bold;';
            btn.addEventListener('click', onClick);
            return btn;
        };

        const healBtn = makeBtn('Buy Healing Potion (15 gold)', () => {
            this.purchaseFromTestSalesmen(this.HEALING_POTION_TYPE, 15, 'Healing Potion');
            gold.textContent = getGoldText();
        });
        wrap.appendChild(healBtn);

        const tntBtn = makeBtn('Buy TNT (60 gold)', () => {
            this.purchaseFromTestSalesmen(this.TNT_TYPE, 60, 'TNT');
            gold.textContent = getGoldText();
        });
        wrap.appendChild(tntBtn);

        const closeBtn = makeBtn('Close', () => this.closeTestSalesmenShop());
        closeBtn.style.background = '#4a4a4a';
        wrap.appendChild(closeBtn);

        document.body.appendChild(wrap);
        this._testSalesmenShopEl = wrap;
    }

    tryInteractWithTestSalesmen() {
        const hitSalesmen = this.raycastTestSalesmen(6);
        if (!hitSalesmen) return false;

        if (!this.hasTestSalesmenHome()) {
            this.showTestSalesmenNoHomeDialog();
        } else {
            this.openTestSalesmenShop();
        }
        return true;
    }

    spawnSquirrelAtExact(x, y, z) {
        if (!this.scene) {
            console.error('[spawnSquirrelAtExact] No scene available!');
            return null;
        }
        
        try {
            const pos = new THREE.Vector3(x, y, z);
            const squirrel = new Squirrel(pos, this);
            const mesh = squirrel.createMesh();
            
            if (mesh) {
                this.scene.add(mesh);
            }
            
            this.squirrels.push(squirrel);
            console.log(`[Spawn] Squirrel (exact) at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) - Total: ${this.squirrels.length}`);
            return squirrel;
        } catch (error) {
            console.error('[spawnSquirrelAtExact] Error during spawn:', error);
            return null;
        }
    }

    spawnSacculariusMoleAt(x, z) {
        if (!this.world || !this.scene) return null;
        let surfaceY = this.world.getTerrainHeight(Math.floor(x), Math.floor(z));
        if (surfaceY < this.world.waterLevel - 1) surfaceY = this.world.waterLevel + 1;

        const pos = new THREE.Vector3(x + 0.5, surfaceY + 0.3, z + 0.5);
        const mole = new SacculariusMole(pos, this.survivalMode, this);
        const mesh = mole.createMesh();
        if (mesh) this.scene.add(mesh);
        this.sacculariusMoles.push(mole);
        console.log(`[Spawn] Saccularius Mole at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
        return mole;
    }

    spawnSquirrels(count = 3) {
        if (!this.world || !this.scene) return;
        const radius = Math.max(8, (this.renderDistance * this.world.chunkSize) - 4);
        for (let i = 0; i < count; i++) {
            let spawned = false;
            for (let attempt = 0; attempt < 20 && !spawned; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const r = Math.random() * radius * 0.8;
                const rx = this.player.position.x + Math.cos(angle) * r;
                const rz = this.player.position.z + Math.sin(angle) * r;
                const squirrel = this.spawnSquirrelAt(rx, rz);
                spawned = !!squirrel;
            }
            if (!spawned && this.player) {
                const forward = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw));
                const nearPos = this.player.position.clone().addScaledVector(forward, 4);
                const squirrel = this.spawnSquirrelAtExact(nearPos.x, this.player.position.y, nearPos.z);
                spawned = !!squirrel;
            }
        }
        console.log(`[Spawn] Requested ${count} squirrels; now have ${this.squirrels.length}.`);
    }

    spawnpiggronAt(x, z) {
        if (!this.world) return null;
        let surfaceY = this.world.getTerrainHeight(Math.floor(x), Math.floor(z));
        // If below water, clamp to water surface so spawn still succeeds
        if (surfaceY < this.world.waterLevel - 1) {
            surfaceY = this.world.waterLevel + 1;
        }

        const pos = new THREE.Vector3(x + 0.5, surfaceY + 1.1, z + 0.5);
        const pig = new piggron(pos, this.survivalMode, this.piggronTexture, this);
        const mesh = pig.createMesh();
        if (mesh) this.scene.add(mesh);
        this.pigmen.push(pig);
        console.log(`[Spawn] piggron at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
        return pig;
    }

    // Spawn piggron at exact coordinates (bypasses terrain height), useful for creative menu
    spawnpiggronAtExact(x, y, z) {
        console.log(`[spawnpiggronAtExact] Called with (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
        console.log(`[spawnpiggronAtExact] Scene exists:`, !!this.scene);
        
        if (!this.scene) {
            console.error('[spawnpiggronAtExact] No scene available!');
            return null;
        }
        
        try {
            const pos = new THREE.Vector3(x, y, z);
            console.log(`[spawnpiggronAtExact] Creating piggron instance...`);
            const pig = new piggron(pos, this.survivalMode, this.piggronTexture, this);
            
            console.log(`[spawnpiggronAtExact] Creating mesh...`);
            const mesh = pig.createMesh();
            console.log(`[spawnpiggronAtExact] Mesh created:`, !!mesh);
            
            if (mesh) {
                this.scene.add(mesh);
                console.log(`[spawnpiggronAtExact] Mesh added to scene`);
            } else {
                console.error(`[spawnpiggronAtExact] Mesh creation returned null!`);
                return null;
            }
            
            this.pigmen.push(pig);
            console.log(`[Spawn] piggron (exact) at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) - Total: ${this.pigmen.length}`);
            return pig;
        } catch (error) {
            console.error('[spawnpiggronAtExact] Error during spawn:', error);
            return null;
        }
    }

    spawnPigmen(count = 3) {
        if (!this.world || !this.scene) return;
        const radius = Math.max(8, (this.renderDistance * this.world.chunkSize) - 4);
        for (let i = 0; i < count; i++) {
            let spawned = false;
            for (let attempt = 0; attempt < 20 && !spawned; attempt++) {
                // Bias spawns to be within current visible radius around player
                const angle = Math.random() * Math.PI * 2;
                const r = Math.random() * radius * 0.8;
                const rx = this.player.position.x + Math.cos(angle) * r;
                const rz = this.player.position.z + Math.sin(angle) * r;
                const pig = this.spawnpiggronAt(rx, rz);
                spawned = !!pig;
            }
            // Fallback: spawn near player if random attempts failed
            if (!spawned && this.player) {
                const forward = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw));
                const nearPos = this.player.position.clone().addScaledVector(forward, 3);
                const pig = this.spawnpiggronAtExact(nearPos.x, this.player.position.y, nearPos.z);
                spawned = !!pig;
            }
        }
        console.log(`[Spawn] Requested ${count} pigmen; now have ${this.pigmen.length}.`);
    }

    spawnAstralPigmen(count = 5) {
        if (!this.world || !this.scene) return;
        // Spawn pigmen around the cathedral exterior.
        const layout = (this.world && typeof this.world.getAstralLayout === 'function') ? this.world.getAstralLayout() : null;
        const cx = layout ? layout.cathedralCenterX : 0;
        const cz = layout ? layout.cathedralCenterZ : 0;

        for (let i = 0; i < count; i++) {
            let rx, rz, valid = false;
            // Spawn in a ring around the cathedral (distance 20-25 blocks away)
            while (!valid) {
                const angle = Math.random() * Math.PI * 2;
                const distance = 20 + Math.random() * 5;
                rx = cx + Math.cos(angle) * distance;
                rz = cz + Math.sin(angle) * distance;
                // Make sure they spawn on solid ground
                const surfaceY = this.world.getTerrainHeight(Math.floor(rx), Math.floor(rz));
                if (surfaceY > 50) { // Valid spawn height
                    valid = true;
                    const pos = new THREE.Vector3(rx + 0.5, surfaceY + 1.1, rz + 0.5);
                    const pig = new piggron(pos, this.survivalMode, this.piggronTexture, this);
                    const mesh = pig.createMesh();
                    if (mesh) this.scene.add(mesh);
                    this.pigmen.push(pig);
                }
            }
        }
        console.log(`Spawned ${count} pigmen around astral cathedral`);
    }

    spawnpiggronPriest() {
        if (!this.world || !this.scene) return;
        const layout = (this.world && typeof this.world.getAstralLayout === 'function') ? this.world.getAstralLayout() : null;
        // Spawn inside cathedral using computed astral layout.
        const x = layout ? layout.cathedralCenterX : 0;
        const z = layout ? layout.cathedralCenterZ : 11;

        // Find a valid standing spot near cathedral center:
        // solid floor beneath, with enough air for body + head.
        const startY = layout ? (layout.cathedralAnchorY + 1) : 70;
        const endY = layout ? (layout.cathedralAnchorY + 24) : 100;
        let y = layout ? (layout.cathedralAnchorY + 1.1) : 77.5;
        for (let wy = startY; wy <= endY; wy++) {
            const floor = this.world.getBlock(Math.floor(x), wy - 1, Math.floor(z));
            const body = this.world.getBlock(Math.floor(x), wy, Math.floor(z));
            const head = this.world.getBlock(Math.floor(x), wy + 1, Math.floor(z));
            if (this.world.isBlockSolid(floor) && !this.world.isBlockSolid(body) && !this.world.isBlockSolid(head)) {
                y = wy + 1.1;
                break;
            }
        }

        const pos = new THREE.Vector3(x, y, z);
        this.piggronPriest = new piggronPriest(pos, this.survivalMode);
        const mesh = this.piggronPriest.createMesh();
        if (mesh) this.scene.add(mesh);
        console.log('Spawned piggron Priest boss in astral cathedral!');
    }

    spawnPhinox() {
        if (this.phinox) {
            console.log('Phinox already exists!');
            return;
        }
        
        // Spawn directly at player position
        const spawnPos = this.player.position.clone();
        
        this.phinox = new Phinox(spawnPos);
        this.phinox.createMesh();
        if (this.phinox.mesh) {
            this.scene.add(this.phinox.mesh);
            console.log('Phinox summoned!');
            
            // Automatically mount the player
            this.mountPhinox();
        }
    }

    mountPhinox() {
        if (!this.phinox || this.isMountedOnPhinox) return;
        
        this.isMountedOnPhinox = true;
        this.phinox.mount(this.player);
        this.phinox.yaw = this.player.yaw;
        console.log('Mounted on Phinox!');
    }

    dismountPhinox() {
        if (!this.phinox || !this.isMountedOnPhinox) return;
        
        this.isMountedOnPhinox = false;
        this.phinox.dismount();
        
        // Place player slightly to the side
        this.player.position.copy(this.phinox.position);
        this.player.position.x += 2;
        console.log('Dismounted from Phinox');
    }

    recallPhinox() {
        if (!this.phinox) return;
        
        // Dismount if mounted
        if (this.isMountedOnPhinox) {
            this.dismountPhinox();
        }
        
        // Remove mesh from scene
        if (this.phinox.mesh && this.scene) {
            this.scene.remove(this.phinox.mesh);
        }
        
        // Clear the phinox reference
        this.phinox = null;
        this.isMountedOnPhinox = false;
        console.log('Phinox recalled to inventory!');
    }

    updateSquirrels(deltaTime) {
        if (!this.squirrels || this.squirrels.length === 0) return;
        // Update every frame for lively behavior
        const startTime = performance.now();
        for (const squirrel of this.squirrels) {
            squirrel.update(this.world, this.player, deltaTime);
        }
        const elapsed = performance.now() - startTime;
        if (elapsed > 30) {
            console.log(`[PERF] updateSquirrels took ${elapsed.toFixed(2)}ms (${this.squirrels.length} squirrels)`);
        }
    }

    updateSacculariusMoles(deltaTime) {
        if (!this.sacculariusMoles || this.sacculariusMoles.length === 0) return;
        for (let i = this.sacculariusMoles.length - 1; i >= 0; i--) {
            const mole = this.sacculariusMoles[i];
            if (!mole) continue;
            if (mole.isDead) {
                if (mole.mesh && this.scene) this.scene.remove(mole.mesh);
                this.sacculariusMoles.splice(i, 1);
                continue;
            }
            mole.update(this.world, this.player, deltaTime);
        }
    }

    updatePigmen(deltaTime) {
        if (!this.pigmen || this.pigmen.length === 0) return;
        // Throttle: update every 3rd frame for performance
        if (!this._pigmenUpdateCounter) this._pigmenUpdateCounter = 0;
        this._pigmenUpdateCounter++;
        if (this._pigmenUpdateCounter % 3 !== 0) return;
        
        const startTime = performance.now();
        for (let i = this.pigmen.length - 1; i >= 0; i--) {
            const pig = this.pigmen[i];
            if (!pig) continue;
            if (pig.isDead) {
                if (pig.mesh && this.scene) this.scene.remove(pig.mesh);
                this.pigmen.splice(i, 1);
                continue;
            }
            pig.update(this.world, this.player, deltaTime * 3); // Compensate for skipped frames
        }
        const elapsed = performance.now() - startTime;
        if (elapsed > 50) {
            console.warn(`[PERF] updatePigmen took ${elapsed.toFixed(2)}ms (${this.pigmen.length} pigmen)`);
        }
    }

    spawnMinutorAt(x, y, z) {
        if (!this.world) return null;
        
        const pos = new THREE.Vector3(x + 0.5, y + 1.0, z + 0.5);
        const minutor = new Minutor(pos, this.survivalMode);
        const mesh = minutor.createMesh();
        if (mesh) this.scene.add(mesh);
        this.minutors.push(minutor);
        return minutor;
    }

    // --------------------------------------------------
    // Slime spawning / updating helpers
    spawnSlimeAt(x, z) {
        if (!this.world) return null;
        let surfaceY = this.world.getTerrainHeight(Math.floor(x), Math.floor(z));
        if (surfaceY < this.world.waterLevel - 1) {
            surfaceY = this.world.waterLevel + 1;
        }
        const pos = new THREE.Vector3(x + 0.5, surfaceY + 0.8, z + 0.5);
        const slime = new Slime(pos, this.survivalMode, this);
        const mesh = slime.createMesh();
        if (mesh) this.scene.add(mesh);
        this.slimes.push(slime);
        return slime;
    }

    spawnSlimeAtExact(x, y, z) {
        if (!this.scene) return null;
        const pos = new THREE.Vector3(x, y, z);
        const slime = new Slime(pos, this.survivalMode, this);
        const mesh = slime.createMesh();
        if (mesh) this.scene.add(mesh);
        this.slimes.push(slime);
        return slime;
    }

    spawnSlimes(count = 2) {
        if (!this.world || !this.scene) return;
        const radius = Math.max(8, (this.renderDistance * this.world.chunkSize) - 4);
        for (let i = 0; i < count; i++) {
            let spawned = false;
            for (let attempt = 0; attempt < 20 && !spawned; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const r = Math.random() * radius * 0.8;
                const rx = this.player.position.x + Math.cos(angle) * r;
                const rz = this.player.position.z + Math.sin(angle) * r;
                const sy = this.world.getTerrainHeight(Math.floor(rx), Math.floor(rz));
                if (sy < 1) continue;
                const s = this.spawnSlimeAtExact(rx, sy, rz);
                if (s) spawned = true;
            }
        }
        console.log(`[Spawn] Requested ${count} slimes; now have ${this.slimes.length}.`);
    }

    updateSlimes(deltaTime) {
        if (!this.slimes || this.slimes.length === 0) return;
        if (!this._slimesUpdateCounter) this._slimesUpdateCounter = 0;
        this._slimesUpdateCounter++;
        if (this._slimesUpdateCounter % 3 !== 0) return;
        const start = performance.now();
        for (let i = this.slimes.length - 1; i >= 0; i--) {
            const s = this.slimes[i];
            if (!s) continue;
            if (s.isDead) {
                if (s.mesh && this.scene) this.scene.remove(s.mesh);
                this.slimes.splice(i, 1);
                continue;
            }
            s.update(this.world, this.player, deltaTime * 3);
        }
        const elapsed = performance.now() - start;
        if (elapsed > 50) {
            console.warn(`[PERF] updateSlimes took ${elapsed.toFixed(2)}ms (${this.slimes.length} slimes)`);
        }
    }

    refreshMobPopulation() {
        if (!this.player || !this.world) return;
        
        const DESPAWN_DISTANCE = 100; // Despawn mobs beyond this distance
        const TARGET_PIGMEN = 8;
        const TARGET_SLIMES = 5;
        const TARGET_SQUIRRELS = 5;
        const MAX_SACCULARIUS_MOLES = 1;
        
        // Despawn and count pigmen
        let pigmenToRemove = [];
        for (let i = 0; i < this.pigmen.length; i++) {
            const pig = this.pigmen[i];
            const dist = pig.position.distanceTo(this.player.position);
            if (dist > DESPAWN_DISTANCE) {
                if (pig.mesh && this.scene) {
                    this.scene.remove(pig.mesh);
                }
                pigmenToRemove.push(i);
            }
        }
        // Remove in reverse order to maintain indices
        for (let i = pigmenToRemove.length - 1; i >= 0; i--) {
            this.pigmen.splice(pigmenToRemove[i], 1);
        }
        
        // Spawn new pigmen if below target
        if (this.pigmen.length < TARGET_PIGMEN) {
            const toSpawn = TARGET_PIGMEN - this.pigmen.length;
            for (let i = 0; i < toSpawn; i++) {
                const angle = Math.random() * Math.PI * 2;
                const radius = 30 + Math.random() * 30;
                const rx = this.player.position.x + Math.cos(angle) * radius;
                const rz = this.player.position.z + Math.sin(angle) * radius;
                this.spawnpiggronAt(rx, rz);
            }
        }
        
        // Despawn and count slimes
        let slimesToRemove = [];
        for (let i = 0; i < this.slimes.length; i++) {
            const slime = this.slimes[i];
            const dist = slime.position.distanceTo(this.player.position);
            if (dist > DESPAWN_DISTANCE) {
                if (slime.mesh && this.scene) {
                    this.scene.remove(slime.mesh);
                }
                slimesToRemove.push(i);
            }
        }
        // Remove in reverse order
        for (let i = slimesToRemove.length - 1; i >= 0; i--) {
            this.slimes.splice(slimesToRemove[i], 1);
        }
        
        // Spawn new slimes if below target
        if (this.slimes.length < TARGET_SLIMES) {
            const toSpawn = TARGET_SLIMES - this.slimes.length;
            for (let i = 0; i < toSpawn; i++) {
                const angle = Math.random() * Math.PI * 2;
                const radius = 25 + Math.random() * 35;
                const rx = this.player.position.x + Math.cos(angle) * radius;
                const rz = this.player.position.z + Math.sin(angle) * radius;
                this.spawnSlimeAt(rx, rz);
            }
        }
        
        // Despawn and count squirrels
        let squirrelsToRemove = [];
        for (let i = 0; i < this.squirrels.length; i++) {
            const squirrel = this.squirrels[i];
            const dist = squirrel.position.distanceTo(this.player.position);
            if (dist > DESPAWN_DISTANCE) {
                if (squirrel.mesh && this.scene) {
                    this.scene.remove(squirrel.mesh);
                }
                squirrelsToRemove.push(i);
            }
        }
        // Remove in reverse order
        for (let i = squirrelsToRemove.length - 1; i >= 0; i--) {
            this.squirrels.splice(squirrelsToRemove[i], 1);
        }
        
        // Spawn new squirrels if below target
        if (this.squirrels.length < TARGET_SQUIRRELS) {
            const toSpawn = TARGET_SQUIRRELS - this.squirrels.length;
            for (let i = 0; i < toSpawn; i++) {
                const angle = Math.random() * Math.PI * 2;
                const radius = 20 + Math.random() * 40;
                const rx = this.player.position.x + Math.cos(angle) * radius;
                const rz = this.player.position.z + Math.sin(angle) * radius;
                this.spawnSquirrelAt(rx, rz);
            }
        }

        let molesToRemove = [];
        for (let i = 0; i < this.sacculariusMoles.length; i++) {
            const mole = this.sacculariusMoles[i];
            const dist = mole.position.distanceTo(this.player.position);
            if (dist > DESPAWN_DISTANCE) {
                if (mole.mesh && this.scene) this.scene.remove(mole.mesh);
                molesToRemove.push(i);
            }
        }
        for (let i = molesToRemove.length - 1; i >= 0; i--) {
            this.sacculariusMoles.splice(molesToRemove[i], 1);
        }

        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (this.sacculariusMoles.length < MAX_SACCULARIUS_MOLES && now - this.lastMoleSpawnRollTime >= 15000) {
            this.lastMoleSpawnRollTime = now;
            if (Math.random() < 0.12) {
                const angle = Math.random() * Math.PI * 2;
                const radius = 35 + Math.random() * 35;
                const rx = this.player.position.x + Math.cos(angle) * radius;
                const rz = this.player.position.z + Math.sin(angle) * radius;
                this.spawnSacculariusMoleAt(rx, rz);
            }
        }
    }

    spawnMinutors(count = 2) {
        if (!this.world || !this.scene) return;
        
        // Maze bounds: x,z in [-16,15], floor y=19, corridors at y=20..22
        const mazeMinX = -16;
        const mazeMaxX = 15;
        const mazeMinZ = -16;
        const mazeMaxZ = 15;
        const mazeFloorY = 19;
        
        for (let i = 0; i < count; i++) {
            let spawned = false;
            for (let attempt = 0; attempt < 20 && !spawned; attempt++) {
                // Random position in maze
                const rx = Math.floor(Math.random() * (mazeMaxX - mazeMinX + 1)) + mazeMinX;
                const rz = Math.floor(Math.random() * (mazeMaxZ - mazeMinZ + 1)) + mazeMinZ;
                const ry = mazeFloorY + 1; // Spawn on corridor floor
                
                // Check if spawn position is air (corridor)
                const block = this.world.getBlock(rx, ry, rz);
                if (block === 0) { // Air space in corridor
                    const minutor = this.spawnMinutorAt(rx, ry, rz);
                    spawned = !!minutor;
                }
            }
        }
        console.log(`Spawned ${this.minutors.length} Minutors in the maze`);
    }

    updateMinutors(deltaTime) {
        if (!this.minutors || this.minutors.length === 0) return;
        // Throttle: update every 3rd frame for performance
        if (!this._minutorUpdateCounter) this._minutorUpdateCounter = 0;
        this._minutorUpdateCounter++;
        if (this._minutorUpdateCounter % 3 !== 0) return;
        
        const startTime = performance.now();
        for (let i = this.minutors.length - 1; i >= 0; i--) {
            const minutor = this.minutors[i];
            if (!minutor) continue;
            if (minutor.isDead) {
                if (minutor.mesh && this.scene) this.scene.remove(minutor.mesh);
                this.minutors.splice(i, 1);
                continue;
            }
            minutor.update(this.world, this.player, deltaTime * 3); // Compensate for skipped frames
        }
        const elapsed = performance.now() - startTime;
        if (elapsed > 50) {
            console.warn(`[PERF] updateMinutors took ${elapsed.toFixed(2)}ms (${this.minutors.length} minutors)`);
        }
    }

    finalizeEnemyDeath(ent, source = 'unknown') {
        if (!ent) return;

        if (this.piggronPriest && ent === this.piggronPriest) {
            if (this.itemManager) {
                const dropPos = ent.position.clone();
                dropPos.y += 0.5;
                this.itemManager.dropItem(dropPos, 32, 1); // Golden sword
                this.itemManager.dropItem(dropPos.clone().add(new THREE.Vector3(0.5, 0, 0)), 17, 10); // Pork
            }
            if (ent.mesh) this.scene.remove(ent.mesh);
            this.piggronPriest = null;
            this.addToInventory(this.LV1_KEY_TYPE, 1);
            console.log('Received Lv 1 Key from piggron Priest.');
            this.changePlayerGold(2, 'piggron-priest');
            this.grantXP(30, 'piggron-priest');
            return;
        }

        const pigIdx = this.pigmen ? this.pigmen.indexOf(ent) : -1;
        if (pigIdx > -1) {
            if (this.itemManager) {
                const dropPos = ent.position.clone();
                dropPos.y += 0.5;
                this.itemManager.dropItem(dropPos, 17, 3); // Pork
                if (Math.random() < 0.05) {
                    this.itemManager.dropItem(dropPos.clone().add(new THREE.Vector3(0.2, 0, 0)), this.MUSKET_TYPE, 1);
                }
            }
            if (ent.mesh) this.scene.remove(ent.mesh);
            this.pigmen.splice(pigIdx, 1);
            this.changePlayerGold(2, 'piggron');
            this.grantXP(2, 'piggron');
            return;
        }

        const minIdx = this.minutors ? this.minutors.indexOf(ent) : -1;
        if (minIdx > -1) {
            if (this.itemManager) {
                const dropPos = ent.position.clone();
                dropPos.y += 0.5;
                this.itemManager.dropItem(dropPos, 18, 1); // Leather helmet
            }
            if (ent.mesh) this.scene.remove(ent.mesh);
            this.minutors.splice(minIdx, 1);
            this.changePlayerGold(2, 'minutor');
            this.grantXP(5, 'minutor');
            return;
        }

        const slimeIdx = this.slimes ? this.slimes.indexOf(ent) : -1;
        if (slimeIdx > -1) {
            if (ent.mesh) this.scene.remove(ent.mesh);
            this.slimes.splice(slimeIdx, 1);
            this.changePlayerGold(2, 'slime');
            this.grantXP(15, 'slime');
            return;
        }

        const moleIdx = this.sacculariusMoles ? this.sacculariusMoles.indexOf(ent) : -1;
        if (moleIdx > -1) {
            if (ent.mesh) this.scene.remove(ent.mesh);
            this.sacculariusMoles.splice(moleIdx, 1);
            this.changePlayerGold(90, 'saccularius-mole');
            console.log('Saccularius Mole defeated! +90 gold');
            return;
        }
    }

    changePlayerGold(amount, source = 'unknown') {
        if (!this.player) return 0;
        const delta = Math.trunc(Number(amount) || 0);
        if (delta === 0) return 0;

        const oldGold = Math.max(0, Math.trunc(Number(this.player.gold) || 0));
        const nextGold = Math.max(0, oldGold + delta);
        const applied = nextGold - oldGold;
        this.player.gold = nextGold;
        this.updateGoldDisplay();

        if (applied !== 0 && source) {
            const action = applied > 0 ? 'gained' : 'lost';
            console.log(`Player ${action} ${Math.abs(applied)} gold from ${source}. Gold: ${this.player.gold}`);
        }
        return applied;
    }

    grantXP(amount, source = 'unknown') {
        if (!this.player || !this.survivalMode) return;

        const gain = Math.max(0, Math.floor(Number(amount) || 0));
        if (gain <= 0) return;

        // At max level, XP gain is ignored.
        if ((this.player.level || 1) >= (this.player.maxLevel || 27)) {
            this.player.level = this.player.maxLevel;
            this.player.xp = 0;
            this.updateXPBar();
            return;
        }

        this.player.xp = (Number(this.player.xp) || 0) + gain;
        const xpToNext = Math.max(1, Number(this.player.xpToNext) || 100);
        let leveledUp = false;

        while (this.player.xp >= xpToNext && this.player.level < this.player.maxLevel) {
            this.player.xp -= xpToNext;
            this.player.level += 1;
            leveledUp = true;

            const canGainHp = () => {
                const currentBaseHp = Math.max(10, Math.min(50, Number(this.player.baseMaxHealth) || Number(this.player.maxHealth) || 10));
                return currentBaseHp < 50;
            };
            const canGainAp = () => {
                const currentBaseAp = Math.max(5, Math.min(50, Number(this.player.baseMaxAP) || Number(this.player.maxAP) || 5));
                return currentBaseAp < 50;
            };
            const canGainMp = () => (Math.max(3, Math.min(30, Number(this.player.maxMP) || 3)) < 30);

            if (!canGainHp() && !canGainAp() && !canGainMp()) {
                console.log('All level-up rewards are already at max values.');
            } else {
                let rewardApplied = false;
                while (!rewardApplied) {
                    const rewardRaw = window.prompt(
                        `Level ${this.player.level} reached! Choose reward:\n` +
                        `1 = +5 Max HP (base, cap 50)\n` +
                        `2 = +5 Max AP (base, cap 50)\n` +
                        `3 = Mana (+3 max MP, cap 30)`,
                        '1'
                    );
                    const reward = (rewardRaw || '1').trim();

                    if (reward === '2') {
                        if (!canGainAp()) {
                            alert('Cannot level this skill up. Please choose a different skill.');
                            continue;
                        }
                        const oldBase = Math.max(5, Math.min(50, Number(this.player.baseMaxAP) || Number(this.player.maxAP) || 5));
                        this.player.baseMaxAP = Math.min(50, oldBase + 5);
                        const gained = this.player.baseMaxAP - oldBase;
                        this.applyContainerAccessoryBonuses();
                        if (gained > 0) {
                            this.player.ap = Math.min(this.player.maxAP, (Number(this.player.ap) || 0) + gained);
                            console.log(`Level-up reward chosen: +${gained} base Max AP (Base AP: ${this.player.baseMaxAP})`);
                        }
                        this.updateAPBar();
                        rewardApplied = true;
                    } else if (reward === '3') {
                        if (!canGainMp()) {
                            alert('Cannot level this skill up. Please choose a different skill.');
                            continue;
                        }
                        const oldMax = this.player.maxMP;
                        this.player.maxMP = Math.min(30, this.player.maxMP + 3);
                        if (this.player.maxMP > oldMax) {
                            this.player.mp = Math.min(this.player.maxMP, this.player.mp + 3);
                            console.log(`Level-up reward chosen: Mana +3 (Max MP: ${this.player.maxMP})`);
                        }
                        this.updateMPBar();
                        rewardApplied = true;
                    } else {
                        if (!canGainHp()) {
                            alert('Cannot level this skill up. Please choose a different skill.');
                            continue;
                        }
                        const oldBase = Math.max(10, Math.min(50, Number(this.player.baseMaxHealth) || Number(this.player.maxHealth) || 10));
                        this.player.baseMaxHealth = Math.min(50, oldBase + 5);
                        const gained = this.player.baseMaxHealth - oldBase;
                        this.applyContainerAccessoryBonuses();
                        if (gained > 0) {
                            this.player.health = Math.min(this.player.maxHealth, (Number(this.player.health) || 0) + gained);
                            console.log(`Level-up reward chosen: +${gained} base Max HP (Base HP: ${this.player.baseMaxHealth})`);
                        }
                        this.updateHealthBar();
                        rewardApplied = true;
                    }
                }
            }
        }

        if (this.player.level >= this.player.maxLevel) {
            this.player.level = this.player.maxLevel;
            this.player.xp = 0;
            console.log('Max level reached (27).');
        }

        this.updateXPBar();
        if (leveledUp) this.updateInventoryUI();
        if (source) {
            console.log(`Gained ${gain} XP from ${source}. XP: ${this.player.xp}/${xpToNext}, Level: ${this.player.level}`);
        }
    }

    applyGroundPoundDamage() {
        if (!this.player) return;

        const damage = 5;
        const px = this.player.position.x;
        const py = this.player.position.y;
        const pz = this.player.position.z;
        const halfSize = 1.5; // 3x3 area in XZ

        const targets = [];
        if (this.pigmen && this.pigmen.length) targets.push(...this.pigmen);
        if (this.minutors && this.minutors.length) targets.push(...this.minutors);
        if (this.slimes && this.slimes.length) targets.push(...this.slimes);
        if (this.sacculariusMoles && this.sacculariusMoles.length) targets.push(...this.sacculariusMoles);
        if (this.piggronPriest && !this.piggronPriest.isDead) targets.push(this.piggronPriest);

        for (const ent of targets) {
            if (!ent || ent.isDead || !ent.position || typeof ent.takeDamage !== 'function') continue;

            const dx = ent.position.x - px;
            const dz = ent.position.z - pz;
            const dy = Math.abs(ent.position.y - py);

            if (Math.abs(dx) <= halfSize && Math.abs(dz) <= halfSize && dy <= 3.0) {
                const knock = new THREE.Vector3(dx, 0, dz);
                if (knock.lengthSq() > 0.0001) knock.normalize();
                const died = !!ent.takeDamage(damage, knock);
                if (died) this.finalizeEnemyDeath(ent, 'ground-pound');
            }
        }
    }

    setupInput() {
        // Keyboard
        document.addEventListener('keydown', (e) => {
            // If chat input currently active we handle only slash to close it
            if (this.chatActive) {
                if (e.key === '/') {
                    e.preventDefault();
                    if (this.chatInputEl) {
                        this.chatInputEl.style.display = 'none';
                    }
                    this.chatActive = false;
                }
                return;
            }

            // Open chat with slash key
            if (e.key === '/') {
                e.preventDefault();
                if (this.chatInputEl) {
                    this.chatInputEl.style.display = 'block';
                    this.chatInputEl.focus();
                    this.chatActive = true;
                }
                return;
            }

            // Cheat: hold Alt and tap + to gain exactly one level-up worth of XP.
            const isPlusKey = e.key === '+' || e.code === 'NumpadAdd' || (e.key === '=' && e.shiftKey);
            if (e.altKey && isPlusKey) {
                e.preventDefault();
                if (this.player && this.player.level < this.player.maxLevel) {
                    const xpToNext = Math.max(1, Number(this.player.xpToNext) || 100);
                    const currentXp = Math.max(0, Number(this.player.xp) || 0);
                    const needed = Math.max(1, xpToNext - currentXp);
                    this.grantXP(needed, 'cheat');
                } else {
                    console.log('Already at max level.');
                }
                return;
            }

            // Toggle fairia dimension with F7
            if (e.key === 'F7') {
                e.preventDefault();
                if (this.inFairiaDimension || (this.world && this.world.worldType === 'fairia')) {
                    this.exitFairiaDimension();
                } else {
                    this.enterFairiaDimension();
                }
                return;
            }
            // Toggle day/night instantly
            if (e.key === 'F1') {
                e.preventDefault();
                // Flip between morning (0.25) and midnight (0.75)
                this.dayTime = (this.dayTime < 0.5) ? 0.75 : 0.25;
                return;
            }

            // Toggle third/first person
            if (e.key === 'F5') {
                e.preventDefault();
                this.thirdPerson = !this.thirdPerson;
                console.log('Third-person:', this.thirdPerson);
                // when switching modes, ensure visibility updates immediately
                if (this.thirdPerson && this.handBlock && this.handBlock.parent) {
                    try { this.handBlock.parent.remove(this.handBlock); } catch (err) {}
                }
                this.playerModel.visible = !!this.thirdPerson;
                return;
            }

            // Detect double-tap W for sprint
            if ((e.key === 'w' || e.key === 'W') && !this.player.isSprinting) {
                const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                const timeSinceLastW = now - this.player.lastWPressTime;

                if (timeSinceLastW < this.player.wDoubleTapWindow) {
                    // Double-tap detected!
                    this.player.isSprinting = true;
                    this.player.sprintEndTime = now + this.player.sprintDuration;
                    console.log('Sprint activated!');
                }
                this.player.lastWPressTime = now;
            }

            // Agility Cape: double-tap A or D to dash left/right.
            const isAKey = e.key === 'a' || e.key === 'A';
            const isDKey = e.key === 'd' || e.key === 'D';
            if (!e.repeat && (isAKey || isDKey) && this.player.hasAccessoryEquipped(this.AGILITY_CAPE_TYPE)) {
                const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();

                if (isAKey) {
                    const dt = now - this.player.lastAPressTime;
                    if (dt > 0 && dt < this.player.sideDoubleTapWindow) {
                        if (this.player.startSideDash(-1, now)) {
                            console.log('Agility Cape dash left!');
                        }
                    }
                    this.player.lastAPressTime = now;
                }

                if (isDKey) {
                    const dt = now - this.player.lastDPressTime;
                    if (dt > 0 && dt < this.player.sideDoubleTapWindow) {
                        if (this.player.startSideDash(1, now)) {
                            console.log('Agility Cape dash right!');
                        }
                    }
                    this.player.lastDPressTime = now;
                }
            }

            // Toggle no-clip fly mode
            if (e.key === 'F6') {
                e.preventDefault();
                this.player.flyMode = !this.player.flyMode;
                this.player.noClipMode = this.player.flyMode;
                this.player.velocity.y = 0; // Reset vertical velocity when toggling
                console.log('No-clip fly mode:', this.player.flyMode, '(Space=up, Shift=down)');
                return;
            }

            this.player.keys[e.key.toLowerCase()] = true;
            
            // Toggle inventory with E
            if (e.key.toLowerCase() === 'e') {
                e.preventDefault();
                this.toggleInventory();
                return;
            }

            // Toggle pause menu with Tab
            if (e.key === 'Tab') {
                e.preventDefault();
                this.togglePauseMenu();
                return;
            }

            // Toggle creative menu with C (only in non-survival mode)
            if (e.key.toLowerCase() === 'c' && !this.survivalMode) {
                e.preventDefault();
                this.toggleCreativeMenu();
                return;
            }

            // Toggle mob spawn menu with V (only in non-survival mode)
            if (e.key.toLowerCase() === 'v' && !this.survivalMode) {
                e.preventDefault();
                this.toggleSpawnMenu();
                return;
            }

            if (e.key === ' ') {
                e.preventDefault();
                this.player.jump(this.world);

                // If player was holding forward and directly blocked, disable forward for 2s
                try {
                    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                    if ((this.player.keys['w'] || this.player.keys['arrowup']) && this.player.isForwardBlocked(this.world)) {
                        this.player.wDisabledUntil = now + 2000; // 2 seconds
                        // force immediate stop of forward input
                        this.player.keys['w'] = false;
                        this.player.keys['arrowup'] = false;
                    }
                } catch (e) {
                    // ignore
                }
            }

            // Arrow keys for camera look (alternative to mouse) — disabled in fly mode so arrows can be movement
            if (!this.player.flyMode && !this.chatActive) {
                const lookSpeed = 0.05;
                if (e.key === 'ArrowUp') this.player.pitch -= lookSpeed;
                if (e.key === 'ArrowDown') this.player.pitch += lookSpeed;
                if (e.key === 'ArrowLeft') this.player.yaw -= lookSpeed;
                if (e.key === 'ArrowRight') this.player.yaw += lookSpeed;
                this.player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.player.pitch));
            }

            // Block selection by number keys (map to hotbar slots)
            const num = parseInt(e.key);
            if (!isNaN(num)) {
                const slots = document.querySelectorAll('.hotbar-slot');
                if (num >= 1 && num <= slots.length) {
                    const slot = slots[num - 1];
                    const bt = parseInt(slot.dataset.block) || 0;
                    this.player.selectedBlock = bt;
                    this.hotbarIndex = num - 1;
                    this.updateHotbar();
                }
            }
        });

        document.addEventListener('keyup', (e) => {
            this.player.keys[e.key.toLowerCase()] = false;
        });

        // Mouse
        document.addEventListener('mousemove', (e) => {
            if (document.pointerLockElement === this.renderer.domElement) {
                this.player.yaw -= e.movementX * 0.002;
                this.player.pitch -= e.movementY * 0.002;
                this.player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.player.pitch));
            }
        });

        document.addEventListener('click', (e) => {
            // Don't request pointer lock if clicking on inventory UI
            if (this._inventoryEl && this._inventoryEl.contains(e.target)) {
                return;
            }
            
            try {
                const el = this.renderer && this.renderer.domElement;
                if (!el || !document.body.contains(el)) return;
                if (typeof el.requestPointerLock === 'function') {
                    el.requestPointerLock();
                }
            } catch (e) {
                console.warn('requestPointerLock failed or target removed from DOM', e);
            }
        });

        // Mouse buttons
        document.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                // Don't destroy block if a container UI is open
                if (this.openChestPos || this.opencandlePos || this.openCauldronPos) return;
                
                // In survival mode, try to attack piggron first
                if (this.survivalMode) {
                    const attacked = this.attackpiggron();
                    if (!attacked) this.destroyBlock(); // If no piggron hit, destroy block
                } else {
                    this.destroyBlock(); // Normal mode: just destroy block
                }
            }
            if (e.button === 2) {
                // Use Cloud Pillow in off-hand to toggle astral dimension during night
                if (this.hasCloudPillowEquipped()) {
                    // Avoid activating while UI is open
                    if (this.inventoryOpen || this.openChestPos || this.opencandlePos || this.openCauldronPos) return;

                    if (this.inAstralDimension) {
                        this.exitAstralDimension();
                        return;
                    }
                    if (this.isNightTime()) {
                        this.enterAstralDimension();
                        return;
                    }
                }

                // Find the slot with the selected item in inventory (works for both hotbar and main inventory selections)
                let selectedSlot = -1;
                for (let i = 0; i < this.player.inventory.length; i++) {
                    const invItem = this.player.inventory[i];
                    const invType = typeof invItem === 'object' ? invItem.type : invItem;
                    if (invType === this.player.selectedBlock) {
                        selectedSlot = i;
                        break;
                    }
                }

                if (selectedSlot === -1) {
                    // No item selected with current block type
                    this.placeBlock();
                    return;
                }

                const item = this.player.inventory[selectedSlot];

                // Potions are consumables in all modes; handle them before placement
                if ((item && typeof item === 'object' && item.type === this.HEALING_POTION_TYPE) || item === this.HEALING_POTION_TYPE) {
                    if (this.player.health < this.player.maxHealth) {
                        if (typeof item === 'object') {
                            item.amount--;
                            if (item.amount <= 0) {
                                this.player.inventory[selectedSlot] = 0;
                            }
                        } else {
                            this.player.inventory[selectedSlot] = 0;
                        }
                        this.player.health = Math.min(this.player.maxHealth, this.player.health + 6);
                        console.log(`Drank Healing Potion! Restored 6 HP. Health: ${this.player.health}/${this.player.maxHealth}`);
                        this.updateInventoryUI();
                        this.updateHealthBar();
                        return;
                    } else {
                        console.log('Health is already full!');
                        return;
                    }
                }

                // Drink potion of chilling — grants 5 min heat immunity in Fairia
                if ((item && typeof item === 'object' && item.type === this.CHILLING_POTION_TYPE) || item === this.CHILLING_POTION_TYPE) {
                    if (typeof item === 'object') {
                        item.amount--;
                        if (item.amount <= 0) {
                            this.player.inventory[selectedSlot] = 0;
                        }
                    } else {
                        this.player.inventory[selectedSlot] = 0;
                    }
                    this.chillProtectionUntil = Date.now() + 300000; // 5 minutes
                    console.log('Drank Potion of Chilling! Heat protection for 5 minutes.');
                    this.showChillProtectionPopup();
                    this.updateInventoryUI();
                    return;
                }

                // Life Contaner is an accessory now; right-click auto-equips one copy if possible.
                if ((item && typeof item === 'object' && item.type === this.LIFE_CONTANER_TYPE) || item === this.LIFE_CONTANER_TYPE) {
                    const equipped = this.equipContainerAccessoryFromInventorySlot(selectedSlot, this.LIFE_CONTANER_TYPE);
                    if (equipped) {
                        console.log(`Equipped Life Contaner! Max HP: ${this.player.maxHealth}`);
                    }
                    return;
                }

                // Energy Vesseil is an accessory now; right-click auto-equips one copy if possible.
                if ((item && typeof item === 'object' && item.type === this.ENERGY_VESSEIL_TYPE) || item === this.ENERGY_VESSEIL_TYPE) {
                    const equipped = this.equipContainerAccessoryFromInventorySlot(selectedSlot, this.ENERGY_VESSEIL_TYPE);
                    if (equipped) {
                        console.log(`Equipped Energy Vesseil! Max AP: ${this.player.maxAP}`);
                    }
                    return;
                }

                // Check if holding pork to eat it (survival mode only)
                if (this.survivalMode) {
                    if ((item && typeof item === 'object' && item.type === 17) || item === 17) {
                        // Eating pork!
                        if (this.player.health < this.player.maxHealth) {
                            // Consume 1 pork and heal 2 HP
                            if (typeof item === 'object') {
                                item.amount--;
                                if (item.amount <= 0) {
                                    this.player.inventory[selectedSlot] = 0;
                                }
                            } else {
                                // Legacy numeric format: consume single pork
                                this.player.inventory[selectedSlot] = 0;
                            }
                            this.player.health = Math.min(this.player.maxHealth, this.player.health + 2);
                            console.log(`Ate pork! Restored 2 HP. Health: ${this.player.health}/${this.player.maxHealth}`);
                            this.updateInventoryUI();
                            this.updateHealthBar();
                            return; // Don't place block
                        } else {
                            console.log('Health is already full!');
                            return;
                        }
                    }
                }
                
                this.placeBlock();   // Right click - place block
            }
        });

        // Require holding left mouse to break: cancel on mouseup
        document.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                if (this.pendingBreak && this.pendingBreak.timeout) {
                    try { clearTimeout(this.pendingBreak.timeout); } catch (err) {}
                    this.pendingBreak = null;
                    this.setCrosshairProgress(0);
                }
            }
        });

        document.addEventListener('contextmenu', (e) => e.preventDefault());

        // Hotbar clicks
        const hotbarSlots = document.querySelectorAll('.hotbar-slot');
        hotbarSlots.forEach((slot, idx) => {
            slot.addEventListener('click', () => {
                const blockType = parseInt(slot.dataset.block) || 0;
                if (blockType > 0) {
                    this.player.selectedBlock = blockType;
                    this.hotbarIndex = idx;
                    this.updateHotbar();
                }
            });
            // accept drops from inventory
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                let srcIdx = null;
                try { srcIdx = Number(e.dataTransfer.getData('text/plain')); } catch (err) { srcIdx = null; }
                if (isNaN(srcIdx) || srcIdx === null) return;

                // swap inventory[srcIdx] with hotbar slot's item
                const invVal = this.player.inventory[srcIdx] || 0;
                const hotVal = parseInt(slot.dataset.block) || 0;

                // perform swap - handle both stacked objects and old numeric format
                this.player.inventory[srcIdx] = hotVal;
                const blockTypeToStore = typeof invVal === 'object' ? invVal.type : invVal;
                slot.dataset.block = blockTypeToStore;

                // update hotbar display - set text directly on slot
                const blockName = this.blockNames[blockTypeToStore] || '';
                slot.textContent = blockName;

                this.updateInventoryUI();
                this.updateHotbar(); // Refresh hotbar to ensure proper display
                
                if (blockTypeToStore > 0) {
                    this.player.selectedBlock = blockTypeToStore;
                    this.hotbarIndex = idx;
                }
            });
        });

        // Mouse wheel to select hotbar
        document.addEventListener('wheel', (e) => {
            if (this.inventoryOpen) return; // don't change while inventory open
            const slots = document.querySelectorAll('.hotbar-slot');
            if (!slots || slots.length === 0) return;
            e.preventDefault();
            if (e.deltaY > 0) {
                this.hotbarIndex = (this.hotbarIndex + 1) % slots.length;
            } else if (e.deltaY < 0) {
                this.hotbarIndex = (this.hotbarIndex - 1 + slots.length) % slots.length;
            }
            const slot = slots[this.hotbarIndex];
            const bt = parseInt(slot.dataset.block) || 0;
            this.player.selectedBlock = bt;
            this.updateHotbar();
        }, { passive: false });

        // Window resize
        window.addEventListener('resize', () => this.onWindowResize());

        // Gamepad support
        this.gamepadState = {
            connected: false,
            leftStickX: 0,
            leftStickY: 0,
            rightStickX: 0,
            rightStickY: 0,
            buttonsPressed: {},
            inventorySelectedIndex: 0,
            lastStickMoveTime: 0
        };
        window.addEventListener('gamepadconnected', (e) => {
            console.log('Gamepad connected:', e.gamepad.id);
            this.gamepadState.connected = true;
        });
        window.addEventListener('gamepaddisconnected', (e) => {
            console.log('Gamepad disconnected');
            this.gamepadState.connected = false;
        });
    }

    updateGamepadInput() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        if (!gamepads || gamepads.length === 0) return;
        
        const gamepad = gamepads[0]; // Use first connected gamepad
        if (!gamepad) return;

        const deadzone = 0.15;
        
        // Left stick for movement (W/A/S/D) or inventory navigation
        const lx = Math.abs(gamepad.axes[0]) > deadzone ? gamepad.axes[0] : 0;
        const ly = Math.abs(gamepad.axes[1]) > deadzone ? gamepad.axes[1] : 0;
        
        // Right stick for camera look
        const rx = Math.abs(gamepad.axes[2]) > deadzone ? gamepad.axes[2] : 0;
        const ry = Math.abs(gamepad.axes[3]) > deadzone ? gamepad.axes[3] : 0;
        
        // Check if any menu is open (only treat creative menu as open when visible)
        const creativeOpen = this._creativeMenuEl && this._creativeMenuEl.style && this._creativeMenuEl.style.display === 'block';
        const menuOpen = !!(this.inventoryOpen || this.openChestPos || this.opencandlePos || this.openCauldronPos || creativeOpen);
        
        if (menuOpen) {
            // Left stick for inventory navigation with rate limiting
            const now = performance.now();
            const moveDelay = 300; // milliseconds between moves (increased from 200 for better performance)
            
            if (now - this.gamepadState.lastStickMoveTime > moveDelay) {
                // Determine which UI grid is active and query appropriate slots
                let slots = [];
                let cols = 10; // default inventory columns
                let currentMenuType = null;
                
                if (this.inventoryOpen && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.inv-slot'));
                    cols = 10;
                    currentMenuType = 'inventory';
                } else if (this.openChestPos && this._inventoryEl) {
                    // Chest UI uses .chest-slot in a 5x4 grid
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                    cols = 5;
                    currentMenuType = 'chest';
                } else if (this.opencandlePos && this._inventoryEl) {
                    // candle UI also reuses .chest-slot in a 3-column grid
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                    cols = 3;
                    currentMenuType = 'candle';
                } else if (this.openCauldronPos && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                    cols = 3;
                    currentMenuType = 'cauldron';
                } else if (creativeOpen && this._creativeMenuEl) {
                    // Creative menu: navigate its buttons grid (6 columns)
                    slots = Array.from(this._creativeMenuEl.querySelectorAll('button'));
                    cols = 6;
                    currentMenuType = 'creative';
                }

                // Only process if menu type changed or slots changed length
                if (slots && slots.length > 0 && (this.gamepadState.lastMenuType !== currentMenuType || this.gamepadState.lastSlotsLength !== slots.length)) {
                    this.gamepadState.lastMenuType = currentMenuType;
                    this.gamepadState.lastSlotsLength = slots.length;
                    this.gamepadState.inventorySelectedIndex = 0; // Reset to first slot on menu change
                }

                if (slots && slots.length > 0) {
                    // Clamp selected index to bounds
                    this.gamepadState.inventorySelectedIndex = Math.min(Math.max(this.gamepadState.inventorySelectedIndex, 0), slots.length - 1);

                    let moved = false;
                    const currentRow = Math.floor(this.gamepadState.inventorySelectedIndex / cols);
                    const currentCol = this.gamepadState.inventorySelectedIndex % cols;

                    if (ly < -0.5) { // Up
                        if (currentRow > 0) {
                            this.gamepadState.inventorySelectedIndex = Math.max(0, this.gamepadState.inventorySelectedIndex - cols);
                            moved = true;
                        }
                    } else if (ly > 0.5) { // Down
                        const maxRow = Math.floor((slots.length - 1) / cols);
                        if (currentRow < maxRow) {
                            this.gamepadState.inventorySelectedIndex = Math.min(slots.length - 1, this.gamepadState.inventorySelectedIndex + cols);
                            moved = true;
                        }
                    }

                    if (lx < -0.5) { // Left
                        if (currentCol > 0) {
                            this.gamepadState.inventorySelectedIndex--;
                            moved = true;
                        }
                    } else if (lx > 0.5) { // Right
                        if (currentCol < cols - 1 && this.gamepadState.inventorySelectedIndex < slots.length - 1) {
                            this.gamepadState.inventorySelectedIndex++;
                            moved = true;
                        }
                    }

                    if (moved) {
                        this.gamepadState.lastStickMoveTime = now;
                        // Update visual selection highlight - only update changed slots for performance
                        const prevIdx = this.gamepadState.lastInventorySelectedIndex;
                        if (prevIdx !== undefined && prevIdx !== this.gamepadState.inventorySelectedIndex) {
                            if (prevIdx < slots.length) {
                                slots[prevIdx].style.outline = '';
                            }
                        }
                        slots[this.gamepadState.inventorySelectedIndex].style.outline = '3px solid yellow';
                        this.gamepadState.lastInventorySelectedIndex = this.gamepadState.inventorySelectedIndex;
                        
                        // Also scroll into view if inside a scrollable container
                        const selectedEl = slots[this.gamepadState.inventorySelectedIndex];
                        try { if (selectedEl && typeof selectedEl.scrollIntoView === 'function') selectedEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
                    }
                }
            }
        } else {
            // Normal movement when no menu is open
            // Update movement keys based on left stick
            this.player.keys['w'] = ly < -0.3;  // Left stick up = move forward
            this.player.keys['s'] = ly > 0.3;   // Left stick down = move backward
            this.player.keys['a'] = lx < -0.3; // Left stick left = strafe left
            this.player.keys['d'] = lx > 0.3;  // Left stick right = strafe right
            
            // Right stick for camera (similar to mouse look)
            const lookSpeed = 0.08;
            if (Math.abs(rx) > deadzone) {
                this.player.yaw -= rx * lookSpeed;
            }
            if (Math.abs(ry) > deadzone) {
                this.player.pitch -= ry * lookSpeed;
                this.player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.player.pitch));
            }
        }
        
        // Buttons mapping
        // A button (index 0) = Select/Click item in inventory, or Jump when no menu open
        if (gamepad.buttons[0] && gamepad.buttons[0].pressed && !this.gamepadState.buttonsPressed[0]) {
            if (menuOpen) {
                // Menu is open: click the selected inventory slot
                let slots = [];
                if (this.inventoryOpen && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.inv-slot'));
                } else if (this.openChestPos && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                } else if (this.opencandlePos && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                } else if (this.openCauldronPos && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                } else if (creativeOpen && this._creativeMenuEl) {
                    slots = Array.from(this._creativeMenuEl.querySelectorAll('button'));
                }
                
                if (slots && slots.length > 0) {
                    const selectedIdx = Math.min(Math.max(this.gamepadState.inventorySelectedIndex, 0), slots.length - 1);
                    const slot = slots[selectedIdx];
                    if (slot) {
                        slot.click();
                    }
                }
            } else {
                // No menu: jump
                this.player.jump(this.world);
            }
            this.gamepadState.buttonsPressed[0] = true;
        } else if (!gamepad.buttons[0] || !gamepad.buttons[0].pressed) {
            this.gamepadState.buttonsPressed[0] = false;
        }
        
        // B button (index 1) = Sprint/Alternative
        if (gamepad.buttons[1] && gamepad.buttons[1].pressed && !this.gamepadState.buttonsPressed[1]) {
            this.gamepadState.buttonsPressed[1] = true;
        } else if (!gamepad.buttons[1] || !gamepad.buttons[1].pressed) {
            this.gamepadState.buttonsPressed[1] = false;
        }
        
        // X button (index 2) = Toggle creative menu (only in non-survival mode)
        if (gamepad.buttons[2] && gamepad.buttons[2].pressed && !this.gamepadState.buttonsPressed[2]) {
            if (!this.survivalMode) {
                this.toggleCreativeMenu();
            }
            this.gamepadState.buttonsPressed[2] = true;
        } else if (!gamepad.buttons[2] || !gamepad.buttons[2].pressed) {
            this.gamepadState.buttonsPressed[2] = false;
        }
        
        // LT (Left Trigger, index 6) = Place block
        if (gamepad.buttons[6] && gamepad.buttons[6].pressed && !this.gamepadState.buttonsPressed[6]) {
            this.placeBlock();
            this.gamepadState.buttonsPressed[6] = true;
        } else if (!gamepad.buttons[6] || !gamepad.buttons[6].pressed) {
            this.gamepadState.buttonsPressed[6] = false;
        }
        
        // RT (Right Trigger, index 7) = Destroy block
        if (gamepad.buttons[7] && gamepad.buttons[7].pressed && !this.gamepadState.buttonsPressed[7]) {
            if (!this.openChestPos && !this.opencandlePos && !this.openCauldronPos) {
                if (this.survivalMode) {
                    const attacked = this.attackpiggron();
                    if (!attacked) this.destroyBlock();
                } else {
                    this.destroyBlock();
                }
            }
            this.gamepadState.buttonsPressed[7] = true;
        } else if (!gamepad.buttons[7] || !gamepad.buttons[7].pressed) {
            this.gamepadState.buttonsPressed[7] = false;
        }
        
        // Y button (index 3) = Toggle inventory
        if (gamepad.buttons[3] && gamepad.buttons[3].pressed && !this.gamepadState.buttonsPressed[3]) {
            this.toggleInventory();
            this.gamepadState.buttonsPressed[3] = true;
        } else if (!gamepad.buttons[3] || !gamepad.buttons[3].pressed) {
            this.gamepadState.buttonsPressed[3] = false;
        }
        
        // LB (index 4) = Cycle hotbar left
        if (gamepad.buttons[4] && gamepad.buttons[4].pressed && !this.gamepadState.buttonsPressed[4]) {
            const slots = document.querySelectorAll('.hotbar-slot');
            if (slots.length > 0) {
                this.hotbarIndex = (this.hotbarIndex - 1 + slots.length) % slots.length;
                const slot = slots[this.hotbarIndex];
                const bt = parseInt(slot.dataset.block) || 0;
                this.player.selectedBlock = bt;
                this.updateHotbar();
            }
            this.gamepadState.buttonsPressed[4] = true;
        } else if (!gamepad.buttons[4] || !gamepad.buttons[4].pressed) {
            this.gamepadState.buttonsPressed[4] = false;
        }
        
        // RB (index 5) = Cycle hotbar right
        if (gamepad.buttons[5] && gamepad.buttons[5].pressed && !this.gamepadState.buttonsPressed[5]) {
            const slots = document.querySelectorAll('.hotbar-slot');
            if (slots.length > 0) {
                this.hotbarIndex = (this.hotbarIndex + 1) % slots.length;
                const slot = slots[this.hotbarIndex];
                const bt = parseInt(slot.dataset.block) || 0;
                this.player.selectedBlock = bt;
                this.updateHotbar();
            }
            this.gamepadState.buttonsPressed[5] = true;
        } else if (!gamepad.buttons[5] || !gamepad.buttons[5].pressed) {
            this.gamepadState.buttonsPressed[5] = false;
        }
        
        // Menu button (index 9, usually Start) = Pause menu
        if (gamepad.buttons[9] && gamepad.buttons[9].pressed && !this.gamepadState.buttonsPressed[9]) {
            this.togglePauseMenu();
            this.gamepadState.buttonsPressed[9] = true;
        } else if (!gamepad.buttons[9] || !gamepad.buttons[9].pressed) {
            this.gamepadState.buttonsPressed[9] = false;
        }
    }

    updateHotbar() {
        const slots = document.querySelectorAll('.hotbar-slot');
        if (!slots || slots.length === 0) return;

        // Try to align hotbarIndex with selectedBlock if possible
        let foundIndex = -1;
        slots.forEach((slot, i) => {
            const bt = parseInt(slot.dataset.block) || 0;
            if (bt === this.player.selectedBlock && foundIndex === -1) foundIndex = i;
        });
        if (foundIndex !== -1) this.hotbarIndex = foundIndex;

        slots.forEach((slot, i) => {
            if (i === this.hotbarIndex) slot.classList.add('selected'); else slot.classList.remove('selected');
        });
    }

    initializeHotbar() {
        const slots = document.querySelectorAll('.hotbar-slot');
        if (!slots || slots.length === 0) return;

        if (this.survivalMode) {
            // In survival mode: start with empty hotbar
            slots.forEach((slot) => {
                slot.dataset.block = '0';
                slot.textContent = '';
            });
            // Select first slot but with no block
            this.hotbarIndex = 0;
            this.player.selectedBlock = 0;
        } else {
            // In creative mode: populate hotbar with common blocks (include musket as last slot)
            const blockTypes = [1, 2, 3, 4, 5, 6, 7, 8, 12, this.MUSKET_TYPE];
            slots.forEach((slot, i) => {
                if (i < blockTypes.length) {
                    const blockType = blockTypes[i];
                    slot.dataset.block = blockType;
                    slot.textContent = this.blockNames[blockType] || '';
                } else {
                    slot.dataset.block = '0';
                    slot.textContent = '';
                }
            });
            // Select first slot with Dirt
            this.hotbarIndex = 0;
            this.player.selectedBlock = 1;
        }
        
        this.updateHotbar();
    }

    raycastBlock() {
        const camera = this.player.getCamera();
        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(camera.quaternion);

        const step = 0.2;
        let currentPos = camera.position.clone();
        let maxDistance = 6;
        let traveled = 0;

        // Track last empty voxel so we can place on the face we hit
        let lastEmpty = null;

        while (traveled < maxDistance) {
            currentPos.addScaledVector(direction, step);
            traveled += step;

            const x = Math.floor(currentPos.x);
            const y = Math.floor(currentPos.y);
            const z = Math.floor(currentPos.z);

            const blockType = this.world.getBlock(x, y, z);

            if (blockType === 0 || blockType === 5) {
                lastEmpty = { x, y, z }; // Remember nearest empty to place against
                continue;
            }

            // Hit a solid block: return hit plus adjacent empty spot if known
            return {
                x,
                y,
                z,
                blockType,
                distance: traveled,
                placeX: lastEmpty ? lastEmpty.x : x,
                placeY: lastEmpty ? lastEmpty.y : y + 1,
                placeZ: lastEmpty ? lastEmpty.z : z
            };
        }

        return null;
    }

    destroyBlock() {
        // Ignore if a container UI is open
        if (this.openChestPos || this.opencandlePos || this.openCauldronPos) return;

        const hit = this.raycastBlock();
        if (!hit) {
            this.setCrosshairProgress(0);
            return;
        }

        // Cancel any existing pending break if targeting a new block
        if (this.pendingBreak && this.pendingBreak.timeout) {
            const sameTarget = this.pendingBreak.x === hit.x && this.pendingBreak.y === hit.y && this.pendingBreak.z === hit.z;
            if (sameTarget) return; // Already breaking this block
            clearTimeout(this.pendingBreak.timeout);
            this.pendingBreak = null;
            this.setCrosshairProgress(0);
        }

        // Creative mode breaks blocks immediately.
        if (!this.survivalMode) {
            this.performBlockDestruction(hit);
            this.pendingBreak = null;
            this.setCrosshairProgress(0);
            return;
        }

        // Start delayed break (4s)
        let duration = this.getBreakDuration(hit.blockType);
        const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const timeout = setTimeout(() => {
            const currentType = this.world.getBlock(hit.x, hit.y, hit.z);
            if (currentType === hit.blockType) {
                this.performBlockDestruction(hit);
            }
            this.pendingBreak = null;
            this.setCrosshairProgress(0);
        }, duration);

        this.pendingBreak = { x: hit.x, y: hit.y, z: hit.z, timeout, startTime, duration };
    }

    performBlockDestruction(hit) {
        // TNT uses a fuse: flash for 5s, then explode.
        if (hit.blockType === this.TNT_TYPE) {
            this.primeTNT(hit.x, hit.y, hit.z, 5000);
            this.setCrosshairProgress(0);
            return;
        }

        // Remove any Man Poster paintings whose backing block is the one being destroyed
        if (this.paintings && this.paintings.length > 0) {
            this.paintings = this.paintings.filter(p => {
                if (p.backX === hit.x && p.backY === hit.y && p.backZ === hit.z) {
                    this.scene.remove(p.mesh);
                    if (p.mesh.geometry) p.mesh.geometry.dispose();
                    if (p.mesh.material) p.mesh.material.dispose();
                    return false;
                }
                return true;
            });
        }

        // Remove any door groups whose backing block is being destroyed
        if (this.woodDoors && this.woodDoors.length > 0) {
            this.woodDoors = this.woodDoors.filter(d => {
                if (d.backX === hit.x && d.backY === hit.y && d.backZ === hit.z) {
                    this.scene.remove(d.group);
                    if (d.mesh.geometry) d.mesh.geometry.dispose();
                    if (d.mesh.material) d.mesh.material.dispose();
                    return false;
                }
                return true;
            });
        }
        if (this.dungeonDoors && this.dungeonDoors.length > 0) {
            this.dungeonDoors = this.dungeonDoors.filter(d => {
                if (d.backX === hit.x && d.backY === hit.y && d.backZ === hit.z) {
                    this.scene.remove(d.groupL);
                    this.scene.remove(d.groupR);
                    if (d.meshL.geometry) d.meshL.geometry.dispose();
                    if (d.meshL.material) d.meshL.material.dispose();
                    if (d.meshR.geometry) d.meshR.geometry.dispose();
                    if (d.meshR.material) d.meshR.material.dispose();
                    return false;
                }
                return true;
            });
        }

        // Remove torch light if destroying a torch (type 25)
        if (hit.blockType === 25) {
            const lightKey = `${hit.x},${hit.y},${hit.z}`;
            const torchLight = this.torchLights.get(lightKey);
            if (torchLight) {
                this.scene.remove(torchLight);
                this.torchLights.delete(lightKey);
            }
        }
        
        // Drop chest contents if destroying a chest (type 26)
        if (hit.blockType === 26) {
            const chestKey = `${hit.x},${hit.y},${hit.z}`;
            const chestInventory = this.chestStorage.get(chestKey);
            if (chestInventory && this.itemManager) {
                const dropPos = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
                // Drop all items from chest
                for (let i = 0; i < chestInventory.length; i++) {
                    const item = chestInventory[i];
                    if (item && item !== 0) {
                        const itemType = typeof item === 'object' ? item.type : item;
                        const amount = typeof item === 'object' ? item.amount : 1;
                        this.itemManager.dropItem(dropPos, itemType, amount);
                    }
                }
            }
            // Close chest UI if it was open
            if (this.openChestPos === chestKey) {
                this.closeChestUI();
            }
            // Clear chest storage
            this.chestStorage.delete(chestKey);
        }

        // Drop candle contents if destroying a magic candle (type 29)
        if (hit.blockType === 29) {
            const candleKey = `${hit.x},${hit.y},${hit.z}`;
            const candleInv = this.candleStorage.get(candleKey);
            if (candleInv && this.itemManager) {
                const dropPos = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
                for (let i = 0; i < candleInv.length; i++) {
                    const item = candleInv[i];
                    if (item && item !== 0) {
                        const itemType = typeof item === 'object' ? item.type : item;
                        const amount = typeof item === 'object' ? item.amount : 1;
                        this.itemManager.dropItem(dropPos, itemType, amount);
                    }
                }
            }
            if (this.opencandlePos === candleKey) {
                this.closecandleUI();
            }
            this.candleStorage.delete(candleKey);
        }

        // Drop cauldron contents if destroying a cauldron
        if (hit.blockType === this.CAULDRON_TYPE) {
            const cauldronKey = `${hit.x},${hit.y},${hit.z}`;
            const cauldronInv = this.cauldronStorage.get(cauldronKey);
            if (cauldronInv && this.itemManager) {
                const dropPos = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
                for (let i = 0; i < cauldronInv.length; i++) {
                    const item = cauldronInv[i];
                    if (item && item !== 0) {
                        const itemType = typeof item === 'object' ? item.type : item;
                        const amount = typeof item === 'object' ? item.amount : 1;
                        this.itemManager.dropItem(dropPos, itemType, amount);
                    }
                }
            }
            if (this.openCauldronPos === cauldronKey) {
                this.closecauldronUI();
            }
            this.cauldronStorage.delete(cauldronKey);
        }

        if (hit.blockType === this.CONNECTER_BLOCK_TYPE) {
            this.connectorData.delete(`${hit.x},${hit.y},${hit.z}`);
        }
        
        this.world.setBlock(hit.x, hit.y, hit.z, 0); // Set to air
        this.setCrosshairProgress(0);
        
        // In survival mode, add broken block to inventory
        if (this.survivalMode && hit.blockType !== 0 && hit.blockType !== 5) {
            // Try to add to existing stack of same block type
            let added = false;
            for (let i = 0; i < this.player.inventory.length; i++) {
                const slot = this.player.inventory[i];
                if (slot && slot.type === hit.blockType && slot.amount < 99) {
                    slot.amount++;
                    added = true;
                    break;
                }
            }
            // If no partial stack found, find first empty slot
            if (!added) {
                for (let i = 0; i < this.player.inventory.length; i++) {
                    if (this.player.inventory[i] === 0) {
                        this.player.inventory[i] = { type: hit.blockType, amount: 1 };
                        added = true;
                        break;
                    }
                }
            }
            // If inventory is full, log a message
            if (!added) {
                console.log('Inventory full! Block was destroyed but not collected.');
            }
            this.updateInventoryUI();
        }
        
        const cx = Math.floor(hit.x / this.world.chunkSize);
        const cz = Math.floor(hit.z / this.world.chunkSize);
        
        // Queue mesh updates instead of doing them immediately (reduces lag)
        this.queueChunkMeshUpdate(cx, cz);
        
        // Queue updates for adjacent chunks if on edge
        if (hit.x % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx - 1, cz);
        if (hit.z % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx, cz - 1);

        // Sync block destruction to server
        if (this.ws && this.ws.readyState === 1) {
            try {
                this.ws.send(JSON.stringify({
                    type: 'blockChange',
                    x: hit.x,
                    y: hit.y,
                    z: hit.z,
                    blockType: 0
                }));
            } catch {}
        }
    }

    primeTNT(x, y, z, fuseMs = 5000) {
        const key = `${x},${y},${z}`;
        if (this.primedTNT.has(key)) return;
        if (this.world.getBlock(x, y, z) !== this.TNT_TYPE) return;

        const flashMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1.03, 1.03, 1.03),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
        );
        flashMesh.position.set(x + 0.5, y + 0.5, z + 0.5);
        flashMesh.visible = true;
        this.scene.add(flashMesh);

        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        this.primedTNT.set(key, {
            x,
            y,
            z,
            fuseMs,
            explodeAtMs: now + fuseMs,
            mesh: flashMesh
        });
    }

    updatePrimedTNT() {
        if (!this.primedTNT || this.primedTNT.size === 0) return;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        for (const [key, tnt] of this.primedTNT) {
            const remaining = tnt.explodeAtMs - now;
            const blinkPeriod = remaining < 1500 ? 100 : 200;
            if (tnt.mesh) {
                tnt.mesh.visible = (Math.floor(now / blinkPeriod) % 2) === 0;
            }

            if (remaining <= 0) {
                if (tnt.mesh) {
                    this.scene.remove(tnt.mesh);
                    if (tnt.mesh.geometry) tnt.mesh.geometry.dispose();
                    if (tnt.mesh.material) tnt.mesh.material.dispose();
                }
                this.primedTNT.delete(key);
                this.explodeTNT(tnt.x, tnt.y, tnt.z);
            }
        }
    }

    explodeTNT(x, y, z) {
        const radius = 3;
        const radiusSq = radius * radius;
        const changedChunks = new Set();

        // Play explosion audio, allowing overlaps from chain reactions.
        try {
            const boom = this.explosionSound ? this.explosionSound.cloneNode() : new Audio('Explotion.ogg');
            boom.volume = this.explosionSound ? this.explosionSound.volume : 0.85;
            boom.play().catch(e => console.log('Explosion sound failed:', e));
        } catch (e) {
            console.log('Explosion sound creation failed:', e);
        }

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    const distSq = dx * dx + dy * dy + dz * dz;
                    if (distSq > radiusSq) continue;

                    const wx = x + dx;
                    const wy = y + dy;
                    const wz = z + dz;
                    const blockType = this.world.getBlock(wx, wy, wz);
                    if (blockType === 0) continue;

                    // Chain nearby TNT quickly instead of deleting it immediately.
                    if (blockType === this.TNT_TYPE && !(wx === x && wy === y && wz === z)) {
                        this.primeTNT(wx, wy, wz, 1200);
                        continue;
                    }

                    this.world.setBlock(wx, wy, wz, 0);

                    if (this.ws && this.ws.readyState === 1) {
                        try {
                            this.ws.send(JSON.stringify({
                                type: 'blockChange',
                                x: wx,
                                y: wy,
                                z: wz,
                                blockType: 0
                            }));
                        } catch {}
                    }

                    const cx = Math.floor(wx / this.world.chunkSize);
                    const cz = Math.floor(wz / this.world.chunkSize);
                    changedChunks.add(`${cx},${cz}`);
                }
            }
        }

        for (const chunkKey of changedChunks) {
            const [cxStr, czStr] = chunkKey.split(',');
            const cx = parseInt(cxStr, 10);
            const cz = parseInt(czStr, 10);
            for (let ox = -1; ox <= 1; ox++) {
                for (let oz = -1; oz <= 1; oz++) {
                    this.queueChunkMeshUpdate(cx + ox, cz + oz);
                }
            }
        }

        if (this.survivalMode && this.player && !this.player.isDead) {
            const blastCenter = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
            const toPlayer = this.player.position.clone().sub(blastCenter);
            const dist = toPlayer.length();
            const damageRange = radius + 2;
            if (dist < damageRange) {
                const dmg = Math.max(2, Math.ceil((damageRange - dist) * 2.5));
                this.player.takeDamage(dmg, null);
                this.updateHealthBar();

                if (dist > 0.001) {
                    toPlayer.normalize();
                    this.player.velocity.add(toPlayer.multiplyScalar(0.18));
                }
            }
        }
    }

    attackpiggron() {
        if ((!this.pigmen || this.pigmen.length === 0) && (!this.slimes || this.slimes.length === 0) && (!this.minutors || this.minutors.length === 0) && (!this.sacculariusMoles || this.sacculariusMoles.length === 0) && (!this.piggronPriest || this.piggronPriest.isDead)) return false;

        const camera = this.player.getCamera();
        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(camera.quaternion);

        const attackRange = 4; // Attack range
        const attackDamage = this.player.getAttackDamage(); // Get damage from equipped weapon
        
        let closestpiggron = null;
        let closestDistance = attackRange;
        let closestSlime = null;
        let closestSlimeDistance = attackRange;
        let closestMole = null;
        let closestMoleDistance = attackRange;

        // Find the closest piggron in front of the player
        for (const pig of this.pigmen) {
            if (pig.isDead) continue;

            const topiggron = pig.position.clone().sub(camera.position);
            const distance = topiggron.length();

            // Check if piggron is within range
            if (distance > attackRange) continue;

            // Check if piggron is roughly in the direction player is looking
            topiggron.normalize();
            const dot = direction.dot(topiggron);
            
            if (dot > 0.7 && distance < closestDistance) { // 0.7 = ~45 degree cone
                closestpiggron = pig;
                closestDistance = distance;
            }
        }

        // Also check slimes
        for (const slime of this.slimes) {
            if (slime.isDead) continue;

            const toSlime = slime.position.clone().sub(camera.position);
            const distance = toSlime.length();
            if (distance > attackRange) continue;

            toSlime.normalize();
            const dot = direction.dot(toSlime);
            if (dot > 0.7 && distance < closestSlimeDistance) {
                closestSlime = slime;
                closestSlimeDistance = distance;
            }
        }

        for (const mole of this.sacculariusMoles) {
            if (mole.isDead) continue;

            const toMole = mole.position.clone().sub(camera.position);
            const distance = toMole.length();
            if (distance > attackRange) continue;

            toMole.normalize();
            const dot = direction.dot(toMole);
            if (dot > 0.7 && distance < closestMoleDistance) {
                closestMole = mole;
                closestMoleDistance = distance;
            }
        }

        // Check for piggron Priest boss
        let closestPriest = null;
        let closestPriestDistance = attackRange;
        if (this.piggronPriest && !this.piggronPriest.isDead) {
            const toPriest = this.piggronPriest.position.clone().sub(camera.position);
            const distance = toPriest.length();
            if (distance <= attackRange) {
                toPriest.normalize();
                const dot = direction.dot(toPriest);
                if (dot > 0.7) {
                    closestPriest = this.piggronPriest;
                    closestPriestDistance = distance;
                }
            }
        }

        // Also check for Minutors
        let closestMinutor = null;
        let closestMinutorDistance = attackRange;

        for (const minutor of this.minutors) {
            if (minutor.isDead) continue;

            const toMinutor = minutor.position.clone().sub(camera.position);
            const distance = toMinutor.length();

            if (distance > attackRange) continue;

            toMinutor.normalize();
            const dot = direction.dot(toMinutor);
            
            if (dot > 0.7 && distance < closestMinutorDistance) {
                closestMinutor = minutor;
                closestMinutorDistance = distance;
            }
        }

        // Attack whichever is closer (prioritize boss)
        if (closestPriest && (!closestMinutor || closestPriestDistance < closestMinutorDistance) && (!closestpiggron || closestPriestDistance < closestDistance) && (!closestSlime || closestPriestDistance < closestSlimeDistance) && (!closestMole || closestPriestDistance < closestMoleDistance)) {
            // Attack piggron Priest Boss
            const knockbackDir = closestPriest.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0;
            
            const died = closestPriest.takeDamage(attackDamage, knockbackDir);
            if (died) {
                this.finalizeEnemyDeath(closestPriest, 'melee');
            }
            return true;
        }

        if (closestMinutor && (!closestpiggron || closestMinutorDistance < closestDistance) && (!closestSlime || closestMinutorDistance < closestSlimeDistance) && (!closestMole || closestMinutorDistance < closestMoleDistance)) {
            // Attack Minutor
            const knockbackDir = closestMinutor.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0;
            
            const died = closestMinutor.takeDamage(attackDamage, knockbackDir);
            if (died) {
                this.finalizeEnemyDeath(closestMinutor, 'melee');
            }
            return true;
        }

        if (closestMole && (!closestpiggron || closestMoleDistance < closestDistance) && (!closestSlime || closestMoleDistance < closestSlimeDistance)) {
            const knockbackDir = closestMole.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0;
            const died = closestMole.takeDamage(attackDamage, knockbackDir);
            if (died) {
                this.finalizeEnemyDeath(closestMole, 'melee');
            }
            return true;
        }

        if (closestpiggron) {
            // Calculate knockback direction (away from player)
            const knockbackDir = closestpiggron.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0; // Keep knockback horizontal
            
            const died = closestpiggron.takeDamage(attackDamage, knockbackDir);
            if (died) {
                this.finalizeEnemyDeath(closestpiggron, 'melee');
            }
            return true; // Attack hit
        }

        // if a slime is actually closer than all the others then hit it
        if (closestSlime) {
            const knockbackDir = closestSlime.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0;
            const died = closestSlime.takeDamage(attackDamage, knockbackDir);
            if (died) {
                this.finalizeEnemyDeath(closestSlime, 'melee');
            }
            return true;
        }
        return false; // No piggron hit
    }

    // Convenience wrapper so Game consumers can query the world.
    // `VoxelWorld` actually implements the logic; forward here to avoid
    // errors when calling from within Game methods or UI code.
    isBlockPlaceable(blockType) {
        if (this.world && typeof this.world.isBlockPlaceable === 'function') {
            return this.world.isBlockPlaceable(blockType);
        }
        return false;
    }

    // Fire the musket weapon if held; we don't perform block placement in
    // that case.
    shootMusket() {
        if (!this.player) return;
        // play firing sound (clone node so multiple shots can overlap)
        if (this.musketSound) {
            try {
                const snd = this.musketSound.cloneNode();
                snd.currentTime = 0;
                snd.play().catch(e => console.log('Musket sound failed:', e));
            } catch (e) {
                console.log('Error playing musket sound:', e);
            }
        }

        const camera = this.player.getCamera();
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
        const startPos = camera.position.clone().add(dir.clone().multiplyScalar(1));
        const speed = 1.2;
        const damage = 15;
        const proj = new Projectile(startPos, dir, speed, damage, this.player);
        // add mesh to our scene so it is rendered
        if (proj.mesh && this.scene) {
            this.scene.add(proj.mesh);
        }
        this.projectiles.push(proj);
    }

    // Place a Man Poster painting flat against the wall face the player is looking at.
    // hit  - the return value from raycastBlock()
    placePainting(hit) {
        if (!hit) return;

        const dx = hit.placeX - hit.x;
        const dy = hit.placeY - hit.y;
        const dz = hit.placeZ - hit.z;

        // Only allow wall faces (not floor/ceiling)
        if (dy !== 0 || (dx === 0 && dz === 0)) {
            console.log('Man Poster can only be placed on a vertical wall face');
            return;
        }

        const OFFSET = 0.03; // push slightly off the wall to prevent z-fighting
        let posX, posY, posZ, rotY;

        if (dx !== 0) {
            // Face on the X axis
            posX = hit.x + (dx > 0 ? 1 : 0) + dx * OFFSET;
            posY = hit.y + 1; // center of 2-block-tall painting
            posZ = hit.z + 0.5;
            rotY = dx > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
            // Face on the Z axis
            posX = hit.x + 0.5;
            posY = hit.y + 1;
            posZ = hit.z + (dz > 0 ? 1 : 0) + dz * OFFSET;
            rotY = dz > 0 ? 0 : Math.PI;
        }

        const geo = new THREE.PlaneGeometry(1, 2);
        const tex = this.manPosterTexture;
        const mat = new THREE.MeshLambertMaterial({
            map: tex || null,
            color: tex ? 0xffffff : 0xc8a87a,
            side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(posX, posY, posZ);
        mesh.rotation.y = rotY;
        this.scene.add(mesh);

        // Record backing block so painting is removed if the wall is broken
        this.paintings.push({ mesh, backX: hit.x, backY: hit.y, backZ: hit.z });
        console.log(`Placed Man Poster at (${posX.toFixed(2)}, ${posY.toFixed(2)}, ${posZ.toFixed(2)})`);
    }

    _makeDoorMat(isWood) {
        const tex = isWood ? this.woodDoorTexture : this.dungeonDoorTexture;
        return new THREE.MeshLambertMaterial({
            map: tex || null,
            color: tex ? 0xffffff : (isWood ? 0x8B4513 : 0xCC0000),
            side: THREE.DoubleSide
        });
    }

    placeDoor(hit, doorType) {
        if (!hit) return;
        const dx = hit.placeX - hit.x;
        const dy = hit.placeY - hit.y;
        const dz = hit.placeZ - hit.z;

        let normalX = dx;
        let normalZ = dz;
        let placeOnFloor = false;

        // Wall placement keeps original behavior. Floor placement uses the player's
        // facing to orient the door so it faces the player naturally.
        if (dy === 1) {
            placeOnFloor = true;
            const sx = Math.sin(this.player.yaw);
            const sz = Math.cos(this.player.yaw);
            if (Math.abs(sx) >= Math.abs(sz)) {
                normalX = sx >= 0 ? 1 : -1;
                normalZ = 0;
            } else {
                normalX = 0;
                normalZ = sz >= 0 ? 1 : -1;
            }
        } else if (dy !== 0 || (dx === 0 && dz === 0)) {
            return;
        }

        if (this.survivalMode) {
            let found = false;
            for (let i = 0; i < this.player.inventory.length; i++) {
                const item = this.player.inventory[i];
                if (!item) continue;
                const type = typeof item === 'object' ? item.type : item;
                if (type === doorType) { found = true; break; }
            }
            if (!found) return;
        }

        const isWood = doorType === this.WOOD_DOOR_TYPE;
        const doorH = isWood ? 3 : 5;
        const OFFSET = 0.03;
        const baseY = placeOnFloor ? hit.placeY : hit.y;
        let posX, posZ, baseRotY;

        if (placeOnFloor) {
            posX = hit.placeX + 0.5;
            posZ = hit.placeZ + 0.5;
            baseRotY = Math.atan2(normalX, normalZ);
        } else if (normalX !== 0) {
            posX = hit.x + (normalX > 0 ? 1 : 0) + normalX * OFFSET;
            posZ = hit.z + 0.5;
            baseRotY = normalX > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
            posX = hit.x + 0.5;
            posZ = hit.z + (normalZ > 0 ? 1 : 0) + normalZ * OFFSET;
            baseRotY = normalZ > 0 ? 0 : Math.PI;
        }

        if (!isWood) {
            // Dungeon door placement is anchored from the clicked bottom-left frame position.
            // Shift center one block to the wall-right so the 3x5 double door fits a frame naturally.
            const rightX = normalZ;
            const rightZ = -normalX;
            posX += rightX;
            posZ += rightZ;
        }

        const isDZFace = normalZ !== 0;
        const doorData = this._buildDoorMeshes(isWood, posX, posZ, baseY, baseRotY, isDZFace, false);
        doorData.backX = hit.x; doorData.backY = hit.y; doorData.backZ = hit.z;

        if (isWood) {
            this.woodDoors.push(doorData);
        } else {
            this.dungeonDoors.push(doorData);
        }

        if (this.survivalMode) {
            for (let i = 0; i < this.player.inventory.length; i++) {
                const item = this.player.inventory[i];
                if (!item) continue;
                const type = typeof item === 'object' ? item.type : item;
                if (type === doorType) {
                    if (typeof item === 'object') {
                        item.amount--;
                        if (item.amount <= 0) this.player.inventory[i] = 0;
                    } else {
                        this.player.inventory[i] = 0;
                    }
                    this.updateInventoryUI();
                    this.updateHotbar();
                    break;
                }
            }
        }
    }

    _buildDoorMeshes(isWood, posX, posZ, baseY, baseRotY, isDZFace, isOpen) {
        const doorH = isWood ? 3 : 5;
        const openAmt = isOpen ? 1 : 0;

        if (isWood) {
            // Hinge at left edge (in door-local space)
            const lhX = isDZFace ? posX - 0.5 : posX;
            const lhZ = isDZFace ? posZ : posZ - 0.5;
            const group = new THREE.Group();
            group.position.set(lhX, baseY, lhZ);
            group.rotation.y = baseRotY - openAmt * Math.PI / 2;
            const geo = new THREE.PlaneGeometry(1, doorH);
            geo.translate(0.5, doorH / 2, 0);
            const mesh = new THREE.Mesh(geo, this._makeDoorMat(true));
            group.add(mesh);
            this.scene.add(group);
            return { group, mesh, lhX, lhZ, baseY, baseRotY, isDZFace, isOpen, animProgress: openAmt };
        } else {
            // Double dungeon door: total width 3 (two 1.5-wide panels)
            const halfWidth = 1.5;
            const panelWidth = 1.5;
            const halfPanel = panelWidth / 2;
            const lhX = isDZFace ? posX - halfWidth : posX;
            const lhZ = isDZFace ? posZ : posZ - halfWidth;
            const rhX = isDZFace ? posX + halfWidth : posX;
            const rhZ = isDZFace ? posZ : posZ + halfWidth;

            const groupL = new THREE.Group();
            groupL.position.set(lhX, baseY, lhZ);
            groupL.rotation.y = baseRotY - openAmt * Math.PI / 2;
            const geoL = new THREE.PlaneGeometry(panelWidth, doorH);
            geoL.translate(halfPanel, doorH / 2, 0);
            const meshL = new THREE.Mesh(geoL, this._makeDoorMat(false));
            groupL.add(meshL);
            this.scene.add(groupL);

            const groupR = new THREE.Group();
            groupR.position.set(rhX, baseY, rhZ);
            groupR.rotation.y = baseRotY + openAmt * Math.PI / 2;
            const geoR = new THREE.PlaneGeometry(panelWidth, doorH);
            geoR.translate(-halfPanel, doorH / 2, 0);
            const meshR = new THREE.Mesh(geoR, this._makeDoorMat(false));
            groupR.add(meshR);
            this.scene.add(groupR);

            return { groupL, meshL, groupR, meshR, lhX, lhZ, rhX, rhZ, baseY, baseRotY, isDZFace, isOpen, animProgress: openAmt };
        }
    }

    recreateDoorMesh(data, doorType) {
        const isWood = doorType === this.WOOD_DOOR_TYPE;
        const d = this._buildDoorMeshes(isWood, 0, 0, data.baseY, data.baseRotY, data.isDZFace, data.isOpen);
        // Restore hinge positions (overwrite what _buildDoorMeshes computed from posX/posZ=0)
        if (isWood) {
            d.group.position.set(data.lhX, data.baseY, data.lhZ);
            d.lhX = data.lhX; d.lhZ = data.lhZ;
        } else {
            d.groupL.position.set(data.lhX, data.baseY, data.lhZ);
            d.groupR.position.set(data.rhX, data.baseY, data.rhZ);
            d.lhX = data.lhX; d.lhZ = data.lhZ;
            d.rhX = data.rhX; d.rhZ = data.rhZ;
        }
        d.backX = data.backX; d.backY = data.backY; d.backZ = data.backZ;
        return d;
    }

    raycastDoor() {
        const camera = this.player.getCamera();
        camera.updateMatrixWorld(true);

        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(camera.quaternion).normalize();

        const ray = new THREE.Ray(camera.position.clone(), direction);
        const maxDistance = 6;
        const meshes = [];
        for (const d of this.woodDoors || []) meshes.push({ mesh: d.mesh, data: d });
        for (const d of this.dungeonDoors || []) {
            meshes.push({ mesh: d.meshL, data: d });
            meshes.push({ mesh: d.meshR, data: d });
        }
        if (!meshes.length) return null;

        const hitPoint = new THREE.Vector3();
        let best = null;
        let bestDist = Infinity;

        for (const entry of meshes) {
            if (!entry.mesh) continue;
            entry.mesh.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(entry.mesh).expandByScalar(0.08);
            if (ray.intersectBox(box, hitPoint)) {
                const dist = camera.position.distanceTo(hitPoint);
                if (dist <= maxDistance && dist < bestDist) {
                    bestDist = dist;
                    best = entry.data;
                }
            }
        }

        return best;
    }

    updateDoorAnimations(deltaTime) {
        const SPEED = 4.0; // 90° in ~0.39 s
        for (const door of this.woodDoors || []) {
            if (door.animProgress === undefined) door.animProgress = door.isOpen ? 1 : 0;
            const target = door.isOpen ? 1 : 0;
            const diff = target - door.animProgress;
            if (Math.abs(diff) > 0.001) {
                const step = Math.sign(diff) * SPEED * deltaTime;
                door.animProgress = Math.max(0, Math.min(1, door.animProgress + (Math.abs(step) > Math.abs(diff) ? diff : step)));
                door.group.rotation.y = door.baseRotY - door.animProgress * Math.PI / 2;
            }
        }
        for (const door of this.dungeonDoors || []) {
            if (door.animProgress === undefined) door.animProgress = door.isOpen ? 1 : 0;
            const target = door.isOpen ? 1 : 0;
            const diff = target - door.animProgress;
            if (Math.abs(diff) > 0.001) {
                const step = Math.sign(diff) * SPEED * deltaTime;
                door.animProgress = Math.max(0, Math.min(1, door.animProgress + (Math.abs(step) > Math.abs(diff) ? diff : step)));
                door.groupL.rotation.y = door.baseRotY - door.animProgress * Math.PI / 2;
                door.groupR.rotation.y = door.baseRotY + door.animProgress * Math.PI / 2;
            }
        }
    }

    getClosedDoorCollisionBoxes() {
        const boxes = [];
        const tmp = new THREE.Box3();

        const pushExpandedBox = (obj) => {
            if (!obj) return;
            obj.updateMatrixWorld(true);
            tmp.setFromObject(obj);
            // Plane meshes have near-zero thickness, so pad slightly for reliable collision.
            tmp.expandByScalar(0.08);
            boxes.push({
                minX: tmp.min.x,
                maxX: tmp.max.x,
                minY: tmp.min.y,
                maxY: tmp.max.y,
                minZ: tmp.min.z,
                maxZ: tmp.max.z
            });
        };

        for (const door of this.woodDoors || []) {
            const p = door.animProgress === undefined ? (door.isOpen ? 1 : 0) : door.animProgress;
            if (p < 0.9) pushExpandedBox(door.group);
        }

        for (const door of this.dungeonDoors || []) {
            const p = door.animProgress === undefined ? (door.isOpen ? 1 : 0) : door.animProgress;
            if (p < 0.9) {
                pushExpandedBox(door.groupL);
                pushExpandedBox(door.groupR);
            }
        }

        return boxes;
    }

    placeBlock() {
        // musket override
        if (this.player.selectedBlock === this.MUSKET_TYPE) {
            this.shootMusket();
            return;
        }

        // Safety: consumable items should never fall through to world placement.
        if (this.isConsumableType(this.player.selectedBlock)) {
            return;
        }

        // Interact with test_salesmen on right-click when targeted.
        if (this.tryInteractWithTestSalesmen()) {
            return;
        }

        // If right-clicking an existing door, toggle it open/closed
        const doorHit = this.raycastDoor();
        if (doorHit) {
            doorHit.isOpen = !doorHit.isOpen;
            return;
        }

        const hit = this.raycastBlock();
        if (hit) {
            // Man Poster: place as a flat painting mesh, not a voxel block
            if (this.player.selectedBlock === this.MAN_POSTER_TYPE) {
                this.placePainting(hit);
                return;
            }

            // Wood Door / Dungeon Door: place as flat door mesh against a wall face
            if (this.player.selectedBlock === this.WOOD_DOOR_TYPE || this.player.selectedBlock === this.DUNGEON_DOOR_TYPE) {
                this.placeDoor(hit, this.player.selectedBlock);
                return;
            }

            // Open chest UI if clicking on a chest
            if (hit.blockType === 26) {
                this.openChest(hit.x, hit.y, hit.z);
                return;
            }

            // Open magic candle UI if clicking on candle
            if (hit.blockType === 29) {
                this.opencandle(hit.x, hit.y, hit.z);
                return;
            }

            // Open cauldron UI if clicking on cauldron
            if (hit.blockType === this.CAULDRON_TYPE) {
                this.opencauldron(hit.x, hit.y, hit.z);
                return;
            }

            // Open structure save UI when right-clicking an existing structure block
            if (hit.blockType === this.STRUCTURE_BLOCK_TYPE) {
                this.openStructureSaveUI();
                return;
            }

            // Open connector UI when right-clicking an existing connector block.
            if (hit.blockType === this.CONNECTER_BLOCK_TYPE) {
                this.openConnectorDataUI(hit.x, hit.y, hit.z);
                return;
            }

            // In survival mode we only allow a restricted set of block IDs to
            // be placed; inventory contains many "items" (scrolls, food, tools)
            // which shouldn't turn into world geometry.  The helper handles the
            // decision and logs when the player attempts to put down something
            // invalid.  For creative mode we bypass this filter entirely so the
            // user can experiment freely – if they pick a non‑placeable item it
            // will still attempt to be placed (it may render oddly, which is
            // acceptable for a sandbox mode).
            if (this.survivalMode && !this.world.isBlockPlaceable(this.player.selectedBlock)) {
                // keeping the old tool/pillow checks for clarity/logging
                if (this.player.selectedBlock === 30) {
                    // chisel
                    return;
                }
                if (this.player.selectedBlock === 31) {
                    // cloud pillow
                    return;
                }
                console.log(`Selected type ${this.player.selectedBlock} is not a placeable block`);
                return;
            }

            // Place block in the last empty voxel we stepped through (face of the hit block)
            const px = hit.placeX;
            const py = hit.placeY;
            const pz = hit.placeZ;

            // Connector requires configured data before placing in the world.
            if (this.player.selectedBlock === this.CONNECTER_BLOCK_TYPE && !this.pendingConnectorData) {
                this.openConnectorDataUI();
                return;
            }

            if (py >= 0 && py < this.world.chunkHeight && this.world.getBlock(px, py, pz) === 0) {
                // Check if player has the selected block in inventory
                let hasBlock = false;
                let inventorySlot = -1;
                
                if (this.survivalMode) {
                    // Find inventory slot with this block type.  We support both
                    // the legacy numeric format (single block) and the newer
                    // object format with type/amount so players can place the
                    // starter items that are pre-filled in survival mode.
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        const item = this.player.inventory[i];
                        if (!item) continue;
                        if (typeof item === 'object') {
                            if (item.type === this.player.selectedBlock && item.amount > 0) {
                                hasBlock = true;
                                inventorySlot = i;
                                break;
                            }
                        } else if (typeof item === 'number') {
                            if (item === this.player.selectedBlock) {
                                hasBlock = true;
                                inventorySlot = i;
                                break;
                            }
                        }
                    }
                    // Don't allow placing if inventory doesn't have the block
                    if (!hasBlock) {
                        console.log('You do not have this block in your inventory.');
                        return;
                    }
                }
                
                this.world.setBlock(px, py, pz, this.player.selectedBlock);

                if (this.player.selectedBlock === this.CONNECTER_BLOCK_TYPE) {
                    this.setConnectorData(px, py, pz, this.pendingConnectorData);
                }
                
                // Structure block: register corner
                if (this.player.selectedBlock === this.STRUCTURE_BLOCK_TYPE) {
                    this.onStructureBlockPlaced(px, py, pz);
                }

                // Torch placement now relies on block-light propagation (no runtime PointLight)
                if (this.player.selectedBlock === 25) {
                    // Lighting recomputed by setBlock -> recomputeLightingAround; refresh nearby meshes
                    console.log(`Placed torch at ${px},${py},${pz}; recomputing lighting`);
                }
                
                // Consume block from inventory in survival mode
                if (this.survivalMode && inventorySlot >= 0) {
                    const item = this.player.inventory[inventorySlot];
                    if (typeof item === 'object') {
                        item.amount--;
                        if (item.amount <= 0) {
                            this.player.inventory[inventorySlot] = 0;
                        }
                    } else {
                        // legacy numeric slot -- placing one consumes it entirely
                        this.player.inventory[inventorySlot] = 0;
                    }
                    this.updateInventoryUI();
                }
                
                const cx = Math.floor(px / this.world.chunkSize);
                const cz = Math.floor(pz / this.world.chunkSize);
                
                // Queue mesh updates instead of doing them immediately (reduces lag)
                this.queueChunkMeshUpdate(cx, cz);
                
                // Queue updates for adjacent chunks if on edge
                if (px % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx - 1, cz);
                if (pz % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx, cz - 1);

                // Sync block placement to server
                if (this.ws && this.ws.readyState === 1) {
                    try {
                        this.ws.send(JSON.stringify({
                            type: 'blockChange',
                            x: px,
                            y: py,
                            z: pz,
                            blockType: this.player.selectedBlock
                        }));
                    } catch {}
                }
            }
        }
    }

    setRenderDistance(value) {
        const next = Math.max(1, Math.min(8, Math.round(Number(value) || 1)));
        if (next === this.renderDistance) return;

        this.renderDistance = next;
        this.chunkMeshQueue = [];
        this.generatingChunkMesh = false;
        this.clearChunkMeshes();
        this.generateInitialChunks();
    }

    getSafeSpawnPositionNear(x = 0, z = 0, radius = 3) {
        if (!this.world) return new THREE.Vector3(x + 0.5, 130, z + 0.5);

        const baseX = Math.floor(x);
        const baseZ = Math.floor(z);
        let bestX = baseX;
        let bestZ = baseZ;
        let bestSurfaceY = -Infinity;

        for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const sx = baseX + dx;
                const sz = baseZ + dz;
                const surfaceY = this.world.getTerrainHeight(sx, sz);
                if (surfaceY > bestSurfaceY) {
                    bestSurfaceY = surfaceY;
                    bestX = sx;
                    bestZ = sz;
                }
            }
        }

        const spawnY = Math.min(this.world.chunkHeight - 3, bestSurfaceY + 3);
        return new THREE.Vector3(bestX + 0.5, spawnY, bestZ + 0.5);
    }

    generateInitialChunks() {
        console.log('Generating initial chunks...');
        const playerChunkX = Math.floor(this.player.position.x / this.world.chunkSize);
        const playerChunkZ = Math.floor(this.player.position.z / this.world.chunkSize);
        
        console.log(`Player at chunk ${playerChunkX}, ${playerChunkZ}`);
        console.log(`Render distance: ${this.renderDistance}`);

        const wr = this.world.worldChunkRadius;
        for (let cx = Math.max(-wr, playerChunkX - this.renderDistance); cx <= Math.min(wr, playerChunkX + this.renderDistance); cx++) {
            for (let cz = Math.max(-wr, playerChunkZ - this.renderDistance); cz <= Math.min(wr, playerChunkZ + this.renderDistance); cz++) {
                this.updateChunkMesh(cx, cz);
            }
        }
        
        console.log(`Total chunks loaded: ${this.chunkMeshes.size}`);
        this.ensureTestSalesmenSpawn();
    }

    updateChunkMesh(cx, cz) {
        try {
            if (!this.mesher) return; // Don't create meshes until mesher is ready
            
            const key = `${cx},${cz}`;

            // Remove old mesh and any debug helpers
            if (this.chunkMeshes.has(key)) {
                const oldMesh = this.chunkMeshes.get(key);
                this.scene.remove(oldMesh);
                try { oldMesh.geometry.dispose(); } catch (e) {}
                try { oldMesh.material.dispose(); } catch (e) {}
                this.chunkBounds.delete(key);
            }
            if (meshDebugHelpers.has(key)) {
                for (const helper of meshDebugHelpers.get(key)) {
                    try { this.scene.remove(helper); } catch (e) {}
                }
                meshDebugHelpers.delete(key);
            }

            // Create new mesh with error handling
            const mesh = this.mesher.createChunkMesh(cx, cz);
            if (mesh) {
                // Mesh vertices are in local chunk coordinates (0 to chunkSize * tileSize)
                // Set mesh position to (0,0,0) since vertices already include world positions
                mesh.position.set(0, 0, 0);
                // Disable shadows in overworld to improve performance; enable in other dimensions
                const shouldCastShadow = this.world.worldType !== 'default';
                mesh.castShadow = shouldCastShadow;
                mesh.receiveShadow = shouldCastShadow;
                // If the mesh has a debug wire in geometry.userData, attach it
                if (mesh.geometry && mesh.geometry.userData && mesh.geometry.userData.debugWire) {
                    const helper = mesh.geometry.userData.debugWire;
                    mesh.add(helper);
                    if (!meshDebugHelpers.has(key)) meshDebugHelpers.set(key, []);
                    meshDebugHelpers.get(key).push(helper);
                }
                this.scene.add(mesh);
                this.chunkMeshes.set(key, mesh);

                // Precompute bounding sphere for frustum culling
                const cs = this.world.chunkSize;
                const ch = this.world.chunkHeight;
                const center = new THREE.Vector3(cx * cs + cs * 0.5, ch * 0.5, cz * cs + cs * 0.5);
                const radius = Math.sqrt((cs * cs * 0.5) + Math.pow(ch * 0.5, 2));
                this.chunkBounds.set(key, { center, radius });
            }
        } catch (e) {
            console.error(`Error updating chunk mesh ${cx},${cz}:`, e);
        }
    }

    validateDoorsAndNPCs() {
        // Remove door meshes whose backing blocks no longer exist
        if (this.woodDoors && this.woodDoors.length > 0) {
            this.woodDoors = this.woodDoors.filter(d => {
                if (!d.mesh || !d.mesh.parent) {
                    // Door mesh was removed or orphaned - check if backing block still exists
                    const backingBlockType = this.world.getBlock(d.backX, d.backY, d.backZ);
                    if (backingBlockType && backingBlockType !== 0) {
                        // Backing block exists, try to recreate the door
                        const newDoor = this.recreateDoorMesh(d, this.WOOD_DOOR_TYPE);
                        if (newDoor) {
                            Object.assign(d, newDoor);
                            return true; // Keep it
                        }
                    } else {
                        // Backing block gone, remove the door entry
                        if (d.group) this.scene.remove(d.group);
                        if (d.mesh) {
                            if (d.mesh.geometry) d.mesh.geometry.dispose();
                            if (d.mesh.material) d.mesh.material.dispose();
                        }
                        return false; // Remove it
                    }
                }
                return true;
            });
        }

        if (this.dungeonDoors && this.dungeonDoors.length > 0) {
            this.dungeonDoors = this.dungeonDoors.filter(d => {
                if (!d.meshL || !d.meshL.parent) {
                    // Door mesh was removed or orphaned - check if backing block still exists
                    const backingBlockType = this.world.getBlock(d.backX, d.backY, d.backZ);
                    if (backingBlockType && backingBlockType !== 0) {
                        // Backing block exists, try to recreate the door
                        const newDoor = this.recreateDoorMesh(d, this.DUNGEON_DOOR_TYPE);
                        if (newDoor) {
                            Object.assign(d, newDoor);
                            return true; // Keep it
                        }
                    } else {
                        // Backing block gone, remove the door entry
                        if (d.groupL) this.scene.remove(d.groupL);
                        if (d.groupR) this.scene.remove(d.groupR);
                        if (d.meshL) {
                            if (d.meshL.geometry) d.meshL.geometry.dispose();
                            if (d.meshL.material) d.meshL.material.dispose();
                        }
                        if (d.meshR) {
                            if (d.meshR.geometry) d.meshR.geometry.dispose();
                            if (d.meshR.material) d.meshR.material.dispose();
                        }
                        return false; // Remove it
                    }
                }
                return true;
            });
        }

        // Ensure TestSalesmen NPC is visible and in sync
        if (this.testSalesmen && this.testSalesmen.mesh) {
            if (!this.testSalesmen.mesh.parent) {
                // Mesh was orphaned, re-add it
                this.scene.add(this.testSalesmen.mesh);
            }
        }
    }

    queueChunkMeshUpdate(cx, cz) {
        // Add to queue instead of updating immediately
        const key = `${cx},${cz}`;
        // Avoid duplicate entries in queue
        if (!this.chunkMeshQueue.some(item => item.cx === cx && item.cz === cz)) {
            this.chunkMeshQueue.push({ cx, cz });
        }
    }

    // Rebuild torch lights by scanning world blocks for torch type (25)
    rebuildTorchLights() {
        // If runtime torch lights are disabled, skip rebuilding
        if (!this.useRuntimeTorchLights) return;
        const now = Date.now();
        // Throttle rebuilds to max once per 5 seconds to avoid freezing
        if (now - this.lastTorchRebuildTime < 5000) return;
        this.lastTorchRebuildTime = now;

        if (!this.scene || !this.world) return;
        if (!this.torchLights) this.torchLights = new Map();

        // Remove existing torch lights
        for (const light of this.torchLights.values()) {
            try { this.scene.remove(light); } catch {}
        }
        this.torchLights.clear();

        // Only scan chunks near player to reduce overhead
        const playerChunkX = Math.floor(this.player.position.x / this.world.chunkSize);
        const playerChunkZ = Math.floor(this.player.position.z / this.world.chunkSize);
        const scanRange = 5; // Only scan nearby chunks

        for (let cx = playerChunkX - scanRange; cx <= playerChunkX + scanRange; cx++) {
            for (let cz = playerChunkZ - scanRange; cz <= playerChunkZ + scanRange; cz++) {
                const key = `${cx},${cz}`;
                const chunk = this.world.chunks.get(key);
                if (!chunk) continue;

                for (let y = 0; y < this.world.chunkHeight; y++) {
                    for (let z = 0; z < this.world.chunkSize; z++) {
                        for (let x = 0; x < this.world.chunkSize; x++) {
                            const idx = this.world.getBlockIndex(x, y, z);
                            const blockType = chunk.blocks[idx] || 0;
                            if (blockType === 25) {
                                const wx = cx * this.world.chunkSize + x;
                                const wy = y;
                                const wz = cz * this.world.chunkSize + z;
                                const lightKey = `${wx},${wy},${wz}`;
                                const torchLight = new THREE.PointLight(0xFFAA55, 1.5, 15);
                                torchLight.position.set(wx + 0.5, wy + 0.5, wz + 0.5);
                                torchLight.castShadow = false;
                                this.scene.add(torchLight);
                                this.torchLights.set(lightKey, torchLight);
                            }
                        }
                    }
                }
            }
        }
    }

    getSconceSmokeTexture() {
        if (this.sconceSmokeTexture) return this.sconceSmokeTexture;

        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        const grad = ctx.createRadialGradient(16, 16, 1, 16, 16, 16);
        grad.addColorStop(0.0, 'rgba(255,255,255,0.9)');
        grad.addColorStop(0.35, 'rgba(240,240,240,0.55)');
        grad.addColorStop(1.0, 'rgba(200,200,200,0.0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 32, 32);

        this.sconceSmokeTexture = new THREE.CanvasTexture(canvas);
        this.sconceSmokeTexture.needsUpdate = true;
        return this.sconceSmokeTexture;
    }

    rebuildSconceEmitters() {
        if (!this.world || !this.player) return;

        const now = Date.now();
        if (now - this.lastSconceEmitterRebuildTime < 1800) return;
        this.lastSconceEmitterRebuildTime = now;

        this.sconceEmitters = [];

        const playerChunkX = Math.floor(this.player.position.x / this.world.chunkSize);
        const playerChunkZ = Math.floor(this.player.position.z / this.world.chunkSize);
        const scanRange = 3;

        for (let cx = playerChunkX - scanRange; cx <= playerChunkX + scanRange; cx++) {
            for (let cz = playerChunkZ - scanRange; cz <= playerChunkZ + scanRange; cz++) {
                const chunk = this.world.chunks.get(`${cx},${cz}`);
                if (!chunk) continue;

                for (let y = 0; y < this.world.chunkHeight; y++) {
                    for (let z = 0; z < this.world.chunkSize; z++) {
                        for (let x = 0; x < this.world.chunkSize; x++) {
                            const idx = this.world.getBlockIndex(x, y, z);
                            const blockType = chunk.blocks[idx] || 0;
                            if (blockType !== 64 && blockType !== 65) continue;

                            const wx = cx * this.world.chunkSize + x;
                            const wz = cz * this.world.chunkSize + z;
                            this.sconceEmitters.push({
                                x: wx + 0.5,
                                y: y + 0.78,
                                z: wz + 0.5,
                                color: blockType === 64 ? 0xff4a4a : 0x5a8dff
                            });
                        }
                    }
                }
            }
        }
    }

    spawnSconceSmokeParticle(emitter) {
        if (!this.scene || !emitter) return;
        const texture = this.getSconceSmokeTexture();
        if (!texture) return;

        const material = new THREE.SpriteMaterial({
            map: texture,
            color: emitter.color,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            depthTest: true
        });

        const sprite = new THREE.Sprite(material);
        const size = 0.13 + Math.random() * 0.08;
        sprite.scale.set(size, size, 1);
        sprite.position.set(
            emitter.x + (Math.random() - 0.5) * 0.16,
            emitter.y,
            emitter.z + (Math.random() - 0.5) * 0.16
        );

        const particle = {
            sprite,
            life: 0,
            maxLife: 0.8 + Math.random() * 0.8,
            baseScale: size,
            vel: new THREE.Vector3(
                (Math.random() - 0.5) * 0.012,
                0.028 + Math.random() * 0.025,
                (Math.random() - 0.5) * 0.012
            )
        };

        this.scene.add(sprite);
        this.sconceSmokeParticles.push(particle);
    }

    updateSconceSmoke(deltaTime) {
        if (!this.scene || !this.world) return;

        this.rebuildSconceEmitters();

        const maxParticles = 320;
        this.sconceSmokeSpawnAccumulator += deltaTime;
        if (this.sconceSmokeSpawnAccumulator >= 0.11 && this.sconceSmokeParticles.length < maxParticles) {
            this.sconceSmokeSpawnAccumulator = 0;
            for (const emitter of this.sconceEmitters) {
                if (this.sconceSmokeParticles.length >= maxParticles) break;
                if (Math.random() < 0.38) this.spawnSconceSmokeParticle(emitter);
            }
        }

        for (let i = this.sconceSmokeParticles.length - 1; i >= 0; i--) {
            const p = this.sconceSmokeParticles[i];
            p.life += deltaTime;

            p.sprite.position.x += p.vel.x * deltaTime * 60;
            p.sprite.position.y += p.vel.y * deltaTime * 60;
            p.sprite.position.z += p.vel.z * deltaTime * 60;

            const t = p.life / p.maxLife;
            p.sprite.material.opacity = Math.max(0, 0.55 * (1 - t));
            const grow = 1 + t * 1.5;
            p.sprite.scale.set(p.baseScale * grow, p.baseScale * grow, 1);

            if (p.life >= p.maxLife) {
                try { this.scene.remove(p.sprite); } catch {}
                if (p.sprite.material) p.sprite.material.dispose();
                this.sconceSmokeParticles.splice(i, 1);
            }
        }
    }

    updateVisibleChunks() {
        const playerChunkX = Math.floor(this.player.position.x / this.world.chunkSize);
        const playerChunkZ = Math.floor(this.player.position.z / this.world.chunkSize);

        // Queue chunks to generate instead of generating synchronously
        const wr = this.world.worldChunkRadius;
        for (let cx = Math.max(-wr, playerChunkX - this.renderDistance); cx <= Math.min(wr, playerChunkX + this.renderDistance); cx++) {
            for (let cz = Math.max(-wr, playerChunkZ - this.renderDistance); cz <= Math.min(wr, playerChunkZ + this.renderDistance); cz++) {
                const key = `${cx},${cz}`;
                if (!this.chunkMeshes.has(key)) {
                    // Add to queue if not already there
                    if (!this.chunkMeshQueue.find(c => c.cx === cx && c.cz === cz)) {
                        this.chunkMeshQueue.push({cx, cz});
                    }
                }
            }
        }

        // Process one chunk mesh per frame from queue
        if (!this.generatingChunkMesh && this.chunkMeshQueue.length > 0) {
            const {cx, cz} = this.chunkMeshQueue.shift();
            this.generatingChunkMesh = true;
            // Use setTimeout to defer after rendering
            setTimeout(() => {
                this.updateChunkMesh(cx, cz);
                this.generatingChunkMesh = false;
            }, 0);
        }

        // Remove far chunks
        for (const [key, mesh] of this.chunkMeshes) {
            const [cx, cz] = key.split(',').map(Number);
            const dist = Math.max(Math.abs(cx - playerChunkX), Math.abs(cz - playerChunkZ));
            if (dist > this.renderDistance + 1) {
                this.scene.remove(mesh);
                mesh.geometry.dispose();
                mesh.material.dispose();
                this.chunkMeshes.delete(key);
                this.chunkBounds.delete(key);
            }
        }

        // Frustum culling: hide chunks outside camera view (throttled to every 5 frames)
        if (!this._frustumCullCounter) this._frustumCullCounter = 0;
        this._frustumCullCounter++;
        if (this._frustumCullCounter % 5 === 0) {
            const frustum = new THREE.Frustum();
            const projScreenMatrix = new THREE.Matrix4();
            projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
            frustum.setFromProjectionMatrix(projScreenMatrix);

            // Reuse sphere object to avoid allocations
            const testSphere = new THREE.Sphere();
            for (const [key, mesh] of this.chunkMeshes) {
                const bounds = this.chunkBounds.get(key);
                if (!bounds) {
                    mesh.visible = true;
                    continue;
                }
                testSphere.center.copy(bounds.center);
                testSphere.radius = bounds.radius;
                mesh.visible = frustum.intersectsSphere(testSphere);
            }
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    updateUI() {
        const pos = this.player.position;
        document.getElementById('fps').textContent = this.fps;
        document.getElementById('pos').textContent = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;

        // Dedicated coordinates HUD
        const hudX = document.getElementById('hud-x');
        const hudY = document.getElementById('hud-y');
        const hudZ = document.getElementById('hud-z');
        if (hudX) hudX.textContent = Math.floor(pos.x);
        if (hudY) hudY.textContent = Math.floor(pos.y);
        if (hudZ) hudZ.textContent = Math.floor(pos.z);
        
        const cx = Math.floor(pos.x / this.world.chunkSize);
        const cz = Math.floor(pos.z / this.world.chunkSize);
        document.getElementById('chunk').textContent = `${cx}, ${cz}`;
        
        document.getElementById('blocks').textContent = this.chunkMeshes.size;

        // Debug: show keys and velocity
        let keysText = '';
        for (const k in this.player.keys) {
            if (this.player.keys[k]) keysText += k + ' ';
        }
        if (!this._keyDebugEl) {
            this._keyDebugEl = document.createElement('div');
            this._keyDebugEl.style.position = 'absolute';
            this._keyDebugEl.style.top = '10px';
            this._keyDebugEl.style.right = '10px';
            this._keyDebugEl.style.background = 'rgba(112, 112, 112, 0.47)';
            this._keyDebugEl.style.color = '#fff';
            this._keyDebugEl.style.padding = '8px';
            this._keyDebugEl.style.fontFamily = 'monospace';
            document.body.appendChild(this._keyDebugEl);
        }
        const modeText = this.survivalMode ? ' [SURVIVAL]' : '';
        this._keyDebugEl.innerText = `Keys: ${keysText}\nVel: ${this.player.velocity.x.toFixed(2)}, ${this.player.velocity.y.toFixed(2)}, ${this.player.velocity.z.toFixed(2)}${modeText}`;
        
        // Update blindness effect
        this.updateBlindnessEffect();
    }

    updateBlindnessEffect() {
        const now = Date.now();
        
        // Create blindness overlay if it doesn't exist
        if (!this._blindnessOverlay) {
            this._blindnessOverlay = document.createElement('div');
            this._blindnessOverlay.id = 'blindness-overlay';
            this._blindnessOverlay.style.position = 'fixed';
            this._blindnessOverlay.style.top = '0';
            this._blindnessOverlay.style.left = '0';
            this._blindnessOverlay.style.width = '100%';
            this._blindnessOverlay.style.height = '100%';
            this._blindnessOverlay.style.backgroundColor = '#000000';
            this._blindnessOverlay.style.pointerEvents = 'none';
            this._blindnessOverlay.style.zIndex = '999';
            this._blindnessOverlay.style.display = 'none';
            document.body.appendChild(this._blindnessOverlay);
        }
        
        // Show or hide blindness overlay based on effect duration
        if (now < this.blindnessEndTime) {
            this._blindnessOverlay.style.display = 'block';
        } else {
            this._blindnessOverlay.style.display = 'none';
        }
    }

    applyBlindness() {
        // 37% chance to apply blindness effect for 4 seconds (4000ms)
        if (Math.random() < 0.37) {
            this.blindnessEndTime = Date.now() + 4000;
        }
    }

    // Inventory UI
    createInventoryUI() {
        if (this._inventoryEl) return;

        const inv = document.createElement('div');
        inv.id = 'inventory';
        inv.style.position = 'absolute';
        inv.style.left = '50%';
        inv.style.top = '50%';
        inv.style.transform = 'translate(-50%, -50%)';
        inv.style.padding = '12px';
        inv.style.background = 'rgba(0,0,0,0.85)';
        inv.style.border = '2px solid #666';
        inv.style.borderRadius = '8px';
        inv.style.display = 'none';
        inv.style.zIndex = '100';
        inv.style.maxWidth = '90vw';
        inv.style.maxHeight = '90vh';
        inv.style.overflowY = 'auto';

        // Add equipment slots section
        const equipmentContainer = document.createElement('div');
        equipmentContainer.style.marginBottom = '16px';
        equipmentContainer.style.padding = '12px';
        equipmentContainer.style.background = 'rgba(0,0,0,0.5)';
        equipmentContainer.style.borderRadius = '4px';

        const equipTitle = document.createElement('div');
        equipTitle.textContent = 'Equipment';
        equipTitle.style.color = '#fff';
        equipTitle.style.fontFamily = 'Arial, sans-serif';
        equipTitle.style.fontSize = '12px';
        equipTitle.style.marginBottom = '8px';
        equipmentContainer.appendChild(equipTitle);

        const equipGrid = document.createElement('div');
        equipGrid.style.display = 'grid';
        equipGrid.style.gridTemplateColumns = 'repeat(7, 60px)';
        equipGrid.style.gridGap = '8px';

        const equipSlots = [
            { key: 'head', label: 'Head' },
            { key: 'body', label: 'Body' },
            { key: 'legs', label: 'Legs' },
            { key: 'boots', label: 'Boots' },
            { key: 'mainHand', label: 'Main' },
            { key: 'offHand', label: 'Off' },
            { key: 'tool', label: 'Tool' },
            { key: 'accessory1', label: 'Acc1' },
            { key: 'accessory2', label: 'Acc2' },
            { key: 'accessory3', label: 'Acc3' },
            { key: 'accessory4', label: 'Acc4' },
            { key: 'accessory5', label: 'Acc5' },
            { key: 'accessory6', label: 'Acc6' },
            { key: 'accessory7', label: 'Acc7' }
        ];

        equipSlots.forEach(({ key, label }) => {
            const slotContainer = document.createElement('div');
            slotContainer.style.display = 'flex';
            slotContainer.style.flexDirection = 'column';
            slotContainer.style.alignItems = 'center';

            const slotLabel = document.createElement('div');
            slotLabel.textContent = label;
            slotLabel.style.color = '#aaa';
            slotLabel.style.fontFamily = 'Arial, sans-serif';
            slotLabel.style.fontSize = '9px';
            slotLabel.style.marginBottom = '2px';
            slotContainer.appendChild(slotLabel);

            const slot = document.createElement('div');
            slot.className = 'equip-slot';
            slot.dataset.equipSlot = key;
            slot.style.width = '60px';
            slot.style.height = '60px';
            slot.style.background = 'rgba(255,200,100,0.1)';
            slot.style.border = '2px solid #a85';
            slot.style.borderRadius = '4px';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.color = '#fff';
            slot.style.fontFamily = 'monospace';
            slot.style.fontSize = '10px';
            slot.style.cursor = 'pointer';

            // Click to unequip or place Ctrl+click item
            slot.addEventListener('click', (e) => {
                // If holding an item from Ctrl+click, place it here
                if (this._heldCtrlItem) {
                    if (!this.canEquipItemInSlot(key, this._heldCtrlItem)) {
                        console.log('You can only equip one Life Contaner and one Energy Vesseil at a time.');
                        return;
                    }
                    const oldEquip = this.player.equipment[key];
                    this.player.equipment[key] = this._heldCtrlItem;
                    this._heldCtrlItem = null;
                    
                    // Put the old equipment back in inventory
                    if (oldEquip && oldEquip !== 0) {
                        for (let i = 0; i < this.player.inventory.length; i++) {
                            if (this.player.inventory[i] === 0) {
                                this.player.inventory[i] = oldEquip;
                                break;
                            }
                        }
                    }
                    this.applyContainerAccessoryBonuses();
                    this.updateInventoryUI();
                    console.log(`Equipped ${label} with Ctrl+click`);
                    return;
                }
                
                // Ctrl+click on equipment: Pick up the item
                if (e.ctrlKey) {
                    const item = this.player.equipment[key];
                    if (item && typeof item === 'object' && item.type) {
                        this._heldCtrlItem = item;
                        this.player.equipment[key] = 0;
                        this.applyContainerAccessoryBonuses();
                        this.updateInventoryUI();
                        console.log(`Picked up ${label} with Ctrl+click`);
                        return;
                    }
                }
                
                // Regular click to unequip
                const item = this.player.equipment[key];
                if (item && typeof item === 'object' && item.type) {
                    // Try to add back to inventory
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        if (this.player.inventory[i] === 0) {
                            this.player.inventory[i] = item;
                            this.player.equipment[key] = 0;
                            this.applyContainerAccessoryBonuses();
                            this.updateInventoryUI();
                            console.log(`Unequipped ${label}`);
                            break;
                        }
                    }
                } else if (typeof item === 'number' && item > 0) {
                    // Try to add back to inventory
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        if (this.player.inventory[i] === 0) {
                            this.player.inventory[i] = item;
                            this.player.equipment[key] = 0;
                            this.applyContainerAccessoryBonuses();
                            this.updateInventoryUI();
                            console.log(`Unequipped ${label}`);
                            break;
                        }
                    }
                }
            });

            // Accept drops from inventory
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                slot.style.background = 'rgba(255,200,100,0.3)';
            });
            slot.addEventListener('dragleave', () => {
                slot.style.background = 'rgba(255,200,100,0.1)';
            });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                slot.style.background = 'rgba(255,200,100,0.1)';
                let srcIdx = null;
                try { srcIdx = Number(e.dataTransfer.getData('text/plain')); } catch (err) { srcIdx = null; }
                if (isNaN(srcIdx) || srcIdx === null) return;

                const item = this.player.inventory[srcIdx];
                if (item && (typeof item === 'object' || (typeof item === 'number' && item > 0))) {
                    if (!this.canEquipItemInSlot(key, item)) {
                        console.log('You can only equip one Life Contaner and one Energy Vesseil at a time.');
                        return;
                    }
                    // Swap with current equipment
                    const oldEquip = this.player.equipment[key];
                    this.player.equipment[key] = item;
                    this.player.inventory[srcIdx] = oldEquip || 0;
                    console.log(`Equipped ${label}: ${this.blockNames[item.type || item]}`);
                    this.applyContainerAccessoryBonuses();
                    this.updateInventoryUI();
                }
            });

            slotContainer.appendChild(slot);
            equipGrid.appendChild(slotContainer);
        });

        equipmentContainer.appendChild(equipGrid);
        inv.appendChild(equipmentContainer);

        // Add crafting grid in survival mode
        if (this.survivalMode) {
            const craftingContainer = document.createElement('div');
            craftingContainer.style.marginBottom = '16px';
            craftingContainer.style.padding = '12px';
            craftingContainer.style.background = 'rgba(0,0,0,0.5)';
            craftingContainer.style.borderRadius = '4px';

            const craftTitle = document.createElement('div');
            craftTitle.textContent = 'Crafting Recipes';
            craftTitle.style.color = '#fff';
            craftTitle.style.fontFamily = 'Arial, sans-serif';
            craftTitle.style.fontSize = '12px';
            craftTitle.style.marginBottom = '8px';
            craftingContainer.appendChild(craftTitle);

            // Store recipes on the instance so we can refresh availability later
            this._recipes = [
                { inputs: { 6: 1 }, result: 13, resultAmount: 2, name: '1 Wood → 2 Planks' },
                { inputs: { 13: 2 }, result: 15, resultAmount: 1, name: '2 Planks → 1 Stick' },
                { inputs: { 13: 1 }, result: 14, resultAmount: 1, name: '1 Plank → 1 Paper' },
                { inputs: { 14: 1, 15: 1 }, result: 16, resultAmount: 1, name: '1 Paper + 1 Stick → 1 Scroll' },
                { inputs: { 17: 2 }, result: 21, resultAmount: 1, name: '2 Pork → Leather Boots' },
                { inputs: { 17: 3 }, result: 20, resultAmount: 1, name: '3 Pork → Leather Leggings' },
                { inputs: { 17: 4 }, result: 18, resultAmount: 1, name: '4 Pork → Leather Helmet' },
                { inputs: { 17: 5 }, result: 19, resultAmount: 1, name: '5 Pork → Leather Chestplate' },
                { inputs: { 3: 2, 15: 1 }, result: 22, resultAmount: 1, name: '2 Stone + 1 Stick → Stone Sword' },
                { inputs: { 15: 1, 24: 1 }, result: 25, resultAmount: 1, name: '1 Stick + 1 Coal → 1 Torch' },
                { inputs: { 16: 1, 8: 1, 27: 1 }, result: 28, resultAmount: 1, name: '1 Scroll + 1 Ruby + 1 Mana Orb → 1 Fortitudo Scroll' },
                { inputs: { 16: 1, 8: 1 }, result: 35, resultAmount: 1, name: '1 Scroll + 1 Ruby → 1 Smiteth Scroll' },
                { inputs: { 1: 1, 27: 1 }, result: 36, resultAmount: 1, name: '1 Dirt + 1 Mana Orb → 1 Gloom' },
                { inputs: { 3: 1, 13: 1 }, result: 30, resultAmount: 1, name: '1 Stone + 1 Plank → 1 Chisel' },
                { inputs: { 1: 5 }, result: 31, resultAmount: 1, name: '5 Dirt → 1 Cloud Pillow' },
                { inputs: { 1: 1 }, result: 10, resultAmount: 1, name: '1 Dirt → 1 Snow (Test)' },
                // musket recipe: 2 planks + 5 coal + 3 stone
                { inputs: { 13: 2, 24: 5, 3: 3 }, result: this.MUSKET_TYPE, resultAmount: 1, name: '2 Planks + 5 Coal + 3 Stone → Musket' },
                { inputs: { 14: 2, 24: 1 }, result: this.MAP_TYPE, resultAmount: 1, name: '2 Paper + 1 Coal → Map' },
                { inputs: { 3: 3, 24: 2 }, result: this.CAULDRON_TYPE, resultAmount: 1, name: '3 Stone + 2 Coal → Cauldron' },
                { inputs: { 13: 4 }, result: this.WOOD_DOOR_TYPE, resultAmount: 1, name: '4 Planks → Wood Door' },
                { inputs: { 8: 2 }, result: this.DUNGEON_DOOR_TYPE, resultAmount: 1, name: '2 Ruby → Dungeon Door' },
                { inputs: { 16: 1, 12: 1 }, result: this.ASTARA_SCROLL_TYPE, resultAmount: 1, name: '1 Scroll + 1 Sapphire → Astara Scroll' },
                { inputs: { 16: 1, 27: 1 }, result: this.CLOUTUMP_SCROLL_TYPE, resultAmount: 1, name: '1 Scroll + 1 Mana Orb → Cloutump Scroll' },
                { inputs: { 16: 1, 24: 1, 3: 2 }, result: this.RUNE_OF_BATTER_TYPE, resultAmount: 1, name: '1 Scroll + 1 Coal + 2 Stone → Rune of the Batter' }
            ];

            // Create recipe list
            const recipeList = document.createElement('div');
            recipeList.className = 'recipe-list';
            recipeList.style.maxHeight = '200px';
            recipeList.style.overflowY = 'auto';
            recipeList.style.display = 'flex';
            recipeList.style.flexDirection = 'column';
            recipeList.style.gap = '4px';

            this._recipes.forEach((recipe, idx) => {
                const recipeBtn = document.createElement('div');
                recipeBtn.className = 'recipe-btn';
                recipeBtn.style.padding = '8px';
                recipeBtn.style.background = 'rgba(100,150,100,0.2)';
                recipeBtn.style.border = '1px solid #6a6';
                recipeBtn.style.borderRadius = '3px';
                recipeBtn.style.color = '#fff';
                recipeBtn.style.fontFamily = 'Arial, sans-serif';
                recipeBtn.style.fontSize = '11px';
                recipeBtn.style.cursor = 'pointer';
                recipeBtn.style.transition = 'background 0.2s';
                recipeBtn.textContent = recipe.name;

                const updateRecipeStyle = () => {
                    const canCraft = this.canCraftRecipe(recipe);
                    if (canCraft) {
                        recipeBtn.style.background = 'rgba(100,200,100,0.3)';
                        recipeBtn.style.borderColor = '#9f9';
                    } else {
                        recipeBtn.style.background = 'rgba(100,100,100,0.2)';
                        recipeBtn.style.borderColor = '#666';
                    }
                };

                updateRecipeStyle();

                recipeBtn.addEventListener('mouseenter', () => {
                    if (this.canCraftRecipe(recipe)) {
                        recipeBtn.style.background = 'rgba(100,255,100,0.4)';
                    }
                });

                recipeBtn.addEventListener('mouseleave', () => {
                    updateRecipeStyle();
                });

                recipeBtn.addEventListener('click', () => {
                    this.craftRecipe(recipe);
                    // Update all recipes styling after crafting
                    recipeList.querySelectorAll('.recipe-btn').forEach((btn, i) => {
                        const canCraft = this.canCraftRecipe(this._recipes[i]);
                        btn.style.background = canCraft ? 'rgba(100,200,100,0.3)' : 'rgba(100,100,100,0.2)';
                        btn.style.borderColor = canCraft ? '#9f9' : '#666';
                    });
                });

                recipeList.appendChild(recipeBtn);
            });

            craftingContainer.appendChild(recipeList);
            inv.appendChild(craftingContainer);
        }

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(10, 48px)';
        grid.style.gridGap = '8px';

        // 30 slots
        for (let i = 0; i < 30; i++) {
            const slot = document.createElement('div');
            slot.className = 'inv-slot';
            slot.dataset.index = i;
            slot.style.width = '48px';
            slot.style.height = '48px';
            slot.style.background = 'rgba(255,255,255,0.06)';
            slot.style.border = '1px solid #444';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.color = '#fff';
            slot.style.fontFamily = 'monospace';
            slot.style.cursor = 'pointer';
            // click to pick
            slot.addEventListener('click', (e) => {
                const idx = Number(slot.dataset.index);
                const item = this.player.inventory[idx];
                
                // If holding an item from Ctrl+click, place it here
                if (this._heldCtrlItem) {
                    const destItem = this.player.inventory[idx];
                    
                    // Empty slot: place the held item
                    if (!destItem || destItem === 0) {
                        this.player.inventory[idx] = this._heldCtrlItem;
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        return;
                    }
                    
                    // Stack with same type
                    if (typeof destItem === 'object' && destItem.type === this._heldCtrlItem.type) {
                        destItem.amount += this._heldCtrlItem.amount;
                        if (destItem.amount > destItem.maxStack) {
                            destItem.amount = destItem.maxStack;
                        }
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        return;
                    }
                    
                    // Different item: swap
                    const temp = this.player.inventory[idx];
                    this.player.inventory[idx] = this._heldCtrlItem;
                    this._heldCtrlItem = null;
                    // Put the displaced item back where it came from if possible
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        if (this.player.inventory[i] === 0) {
                            this.player.inventory[i] = temp;
                            break;
                        }
                    }
                    this.updateInventoryUI();
                    return;
                }
                
                // Ctrl+click: Pick up one item from a stack
                if (e.ctrlKey && item && typeof item === 'object' && item.type && item.amount > 0) {
                    // Store one item for placement
                    this._heldCtrlItem = new Item(item.type, 1);
                    item.amount--;
                    if (item.amount <= 0) {
                        this.player.inventory[idx] = 0;
                    }
                    this.updateInventoryUI();
                    return;
                }
                
                // Regular click to select
                if (item && typeof item === 'object' && item.type) {
                    this.player.selectedBlock = item.type;
                } else if (typeof item === 'number' && item > 0) {
                    this.player.selectedBlock = item;
                }
                this.updateHotbar();
                this.updateInventoryUI();
            });

            // enable HTML5 drag from inventory slot
            slot.draggable = true;
            slot.addEventListener('dragstart', (e) => {
                const idx = Number(slot.dataset.index);
                try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) { /* ignore */ }
                e.dataTransfer.effectAllowed = 'move';
            });
            
            // Accept drops from chest
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const data = e.dataTransfer.getData('chestSource');
                if (data) {
                    slot.style.background = 'rgba(100,200,100,0.3)';
                }
            });
            slot.addEventListener('dragleave', () => {
                slot.style.background = 'rgba(255,255,255,0.06)';
            });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                slot.style.background = 'rgba(255,255,255,0.06)';
                
                const data = e.dataTransfer.getData('chestSource');
                if (!data) return;
                
                try {
                    const sourceData = JSON.parse(data);
                    const containerInventory = this.chestStorage.get(sourceData.chestKey) || this.candleStorage.get(sourceData.chestKey) || this.cauldronStorage.get(sourceData.chestKey);
                    if (!containerInventory) return;
                    
                    const idx = Number(slot.dataset.index);
                    const chestItem = containerInventory[sourceData.slotIndex];
                    const invItem = this.player.inventory[idx];
                    
                    if (chestItem && chestItem !== 0) {
                        // If inventory slot is empty, move item
                        if (!invItem || invItem === 0) {
                            this.player.inventory[idx] = chestItem;
                            containerInventory[sourceData.slotIndex] = 0;
                        }
                        // If same item type, try to stack
                        else if (typeof chestItem === 'object' && typeof invItem === 'object' && chestItem.type === invItem.type) {
                            const space = 99 - invItem.amount;
                            if (space > 0) {
                                const toAdd = Math.min(space, chestItem.amount);
                                invItem.amount += toAdd;
                                chestItem.amount -= toAdd;
                                if (chestItem.amount <= 0) {
                                    containerInventory[sourceData.slotIndex] = 0;
                                }
                            }
                        }
                        // Otherwise swap items
                        else {
                            const temp = this.player.inventory[idx];
                            this.player.inventory[idx] = chestItem;
                            containerInventory[sourceData.slotIndex] = temp;
                        }
                        
                        this.updateInventoryUI();
                        // Refresh container UI to reflect changes
                        this.refreshContainerUI(sourceData.chestKey);
                    }
                } catch (err) {
                    console.error('Chest drop error:', err);
                }
            });
            
            slot.addEventListener('dragend', (e) => {
                // Check if item was dropped outside inventory
                const idx = Number(slot.dataset.index);
                const item = this.player.inventory[idx];
                
                // Get the drop target element
                const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
                
                // Check if dropped outside inventory (not on inv-slot, craft-slot, or craft-result)
                const isInventorySlot = dropTarget && (
                    dropTarget.classList.contains('inv-slot') ||
                    dropTarget.classList.contains('craft-slot') ||
                    dropTarget.classList.contains('craft-result') ||
                    dropTarget.classList.contains('hotbar-slot')
                );
                
                if (!isInventorySlot && item && typeof item === 'object' && item.type) {
                    // Drop the item in the world
                    const dropPosition = this.player.position.clone();
                    // Offset slightly forward from player
                    const forwardOffset = new THREE.Vector3(0, 0, -2);
                    forwardOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.player.yaw);
                    dropPosition.add(forwardOffset);
                    dropPosition.y += 0.5; // Drop at chest height
                    
                    // Drop the item using ItemManager
                    if (this.itemManager) {
                        this.itemManager.dropItem(dropPosition, item.type, item.amount);
                    }
                    
                    // Remove from inventory
                    this.player.inventory[idx] = 0;
                    this.updateInventoryUI();
                }
            });
            grid.appendChild(slot);
        }

        inv.appendChild(grid);
        
        // Mount Menu
        const mountContainer = document.createElement('div');
        mountContainer.style.marginTop = '16px';
        mountContainer.style.padding = '12px';
        mountContainer.style.background = 'rgba(0,0,0,0.5)';
        mountContainer.style.borderRadius = '4px';
        
        const mountTitle = document.createElement('div');
        mountTitle.textContent = 'Mounts';
        mountTitle.style.color = '#fff';
        mountTitle.style.fontFamily = 'Arial, sans-serif';
        mountTitle.style.fontSize = '12px';
        mountTitle.style.marginBottom = '8px';
        mountContainer.appendChild(mountTitle);
        
        const phinoxBtn = document.createElement('button');
        phinoxBtn.textContent = 'Summon Phinox';
        phinoxBtn.style.padding = '8px 16px';
        phinoxBtn.style.background = 'rgba(255,100,0,0.3)';
        phinoxBtn.style.border = '1px solid #f80';
        phinoxBtn.style.borderRadius = '4px';
        phinoxBtn.style.color = '#fff';
        phinoxBtn.style.fontFamily = 'Arial, sans-serif';
        phinoxBtn.style.fontSize = '11px';
        phinoxBtn.style.cursor = 'pointer';
        phinoxBtn.style.marginRight = '8px';
        
        phinoxBtn.addEventListener('click', () => {
            this.spawnPhinox();
            this.toggleInventory(); // Close inventory
        });
        
        mountContainer.appendChild(phinoxBtn);
        
        const dismountBtn = document.createElement('button');
        dismountBtn.textContent = 'Dismount';
        dismountBtn.style.padding = '8px 16px';
        dismountBtn.style.background = 'rgba(100,100,100,0.3)';
        dismountBtn.style.border = '1px solid #888';
        dismountBtn.style.borderRadius = '4px';
        dismountBtn.style.color = '#fff';
        dismountBtn.style.fontFamily = 'Arial, sans-serif';
        dismountBtn.style.fontSize = '11px';
        dismountBtn.style.cursor = 'pointer';
        
        dismountBtn.addEventListener('click', () => {
            if (this.isMountedOnPhinox && this.phinox) {
                this.dismountPhinox();
            }
        });
        
        mountContainer.appendChild(dismountBtn);
        
        const recallBtn = document.createElement('button');
        recallBtn.textContent = 'Recall Phinox';
        recallBtn.style.padding = '8px 16px';
        recallBtn.style.background = 'rgba(100,50,50,0.3)';
        recallBtn.style.border = '1px solid #a66';
        recallBtn.style.borderRadius = '4px';
        recallBtn.style.color = '#fff';
        recallBtn.style.fontFamily = 'Arial, sans-serif';
        recallBtn.style.fontSize = '11px';
        recallBtn.style.cursor = 'pointer';
        recallBtn.style.marginLeft = '8px';
        
        recallBtn.addEventListener('click', () => {
            if (this.phinox) {
                this.recallPhinox();
            }
        });
        
        mountContainer.appendChild(recallBtn);
        inv.appendChild(mountContainer);
        
        document.body.appendChild(inv);
        this._inventoryEl = inv;
        this._craftingGrid = this._craftingGrid || [];
        
        // Create cursor indicator for Ctrl+click held items
        const cursorIndicator = document.createElement('div');
        cursorIndicator.id = 'ctrl-cursor-indicator';
        cursorIndicator.style.position = 'fixed';
        cursorIndicator.style.pointerEvents = 'none';
        cursorIndicator.style.padding = '4px 8px';
        cursorIndicator.style.background = 'rgba(0,0,0,0.85)';
        cursorIndicator.style.border = '1px solid #6f6';
        cursorIndicator.style.borderRadius = '4px';
        cursorIndicator.style.color = '#6f6';
        cursorIndicator.style.fontFamily = 'monospace';
        cursorIndicator.style.fontSize = '11px';
        cursorIndicator.style.display = 'none';
        cursorIndicator.style.zIndex = '1000';
        document.body.appendChild(cursorIndicator);
        this._ctrlCursorIndicator = cursorIndicator;
        
        // Track mouse movement to update cursor indicator
        document.addEventListener('mousemove', (e) => {
            if (this._heldCtrlItem && this._ctrlCursorIndicator) {
                this._ctrlCursorIndicator.style.left = (e.clientX + 15) + 'px';
                this._ctrlCursorIndicator.style.top = (e.clientY + 15) + 'px';
                this._ctrlCursorIndicator.style.display = 'block';
                const itemName = this.blockNames[this._heldCtrlItem.type] || '?';
                this._ctrlCursorIndicator.textContent = `${itemName} x${this._heldCtrlItem.amount}`;
            } else if (this._ctrlCursorIndicator) {
                this._ctrlCursorIndicator.style.display = 'none';
            }
        });
        
        // Right-click to cancel Ctrl+click and return item to inventory
        inv.addEventListener('contextmenu', (e) => {
            if (this._heldCtrlItem) {
                e.preventDefault();
                // Return the held item to first available slot
                for (let i = 0; i < this.player.inventory.length; i++) {
                    const slot = this.player.inventory[i];
                    if (slot === 0) {
                        this.player.inventory[i] = this._heldCtrlItem;
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        break;
                    } else if (typeof slot === 'object' && slot.type === this._heldCtrlItem.type) {
                        slot.amount += this._heldCtrlItem.amount;
                        if (slot.amount > slot.maxStack) {
                            slot.amount = slot.maxStack;
                        }
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        break;
                    }
                }
            }
        });
        
        this.updateInventoryUI();
    }

    updateInventoryUI() {
        if (!this._inventoryEl) return;
        
        // Update equipment slots
        const equipSlots = this._inventoryEl.querySelectorAll('.equip-slot');
        equipSlots.forEach(slot => {
            const key = slot.dataset.equipSlot;
            const item = this.player.equipment[key];
            const name = this.getItemNameWithBonus(item);
            if (name) {
                const shortName = name.length > 8 ? name.substring(0, 6) + '...' : name;
                slot.textContent = shortName;
                slot.style.fontSize = '9px';
                slot.style.whiteSpace = 'pre-line';
                slot.style.textAlign = 'center';
            } else {
                slot.textContent = '';
            }
        });
        
        // Update main inventory slots
        const slots = this._inventoryEl.querySelectorAll('.inv-slot');
        slots.forEach(slot => {
            const idx = Number(slot.dataset.index);
            const item = this.player.inventory[idx];
            const name = this.getItemNameWithBonus(item);
            slot.textContent = name || '';
        });

        // Refresh recipe availability styles
        if (this.survivalMode && this._recipes) {
            const recipeList = this._inventoryEl.querySelector('.recipe-list');
            if (recipeList) {
                const buttons = recipeList.querySelectorAll('.recipe-btn');
                buttons.forEach((btn, i) => {
                    const canCraft = this.canCraftRecipe(this._recipes[i]);
                    btn.style.background = canCraft ? 'rgba(100,200,100,0.3)' : 'rgba(100,100,100,0.2)';
                    btn.style.borderColor = canCraft ? '#9f9' : '#666';
                });
            }
        }
        
        // Update crafting grid display if in survival mode
        if (this.survivalMode && this._craftingGrid) {
            const craftSlots = this._inventoryEl.querySelectorAll('.craft-slot');
            craftSlots.forEach(slot => {
                const idx = Number(slot.dataset.craftIndex);
                const item = this._craftingGrid[idx];
                if (item && typeof item === 'object' && item.type) {
                    const blockName = this.blockNames[item.type] || '';
                    slot.textContent = item.amount > 1 ? 'x' + item.amount : '✓';
                    slot.style.color = '#6f6';
                } else {
                    slot.textContent = '';
                }
            });
            
            // Update result slot display
            const resultSlot = this._inventoryEl.querySelector('.craft-result');
            if (resultSlot) {
                const recipe = this.checkCraftingRecipe();
                if (recipe) {
                    const blockName = this.blockNames[recipe.result] || '';
                    resultSlot.textContent = blockName;
                    resultSlot.style.color = '#6f6';
                    resultSlot.style.cursor = 'pointer';
                } else {
                    resultSlot.textContent = '';
                        // Crafting UI is handled by the recipe list system
                    resultSlot.style.color = '#fff';
                }
            }
        }
    }

    checkCraftingRecipe() {
        // Check if current crafting grid contents match any recipe
        // Returns {result, inputs} if match found, null otherwise
        
        if (!this._craftingGrid) return null;
        
        const recipes = [
            // 1 Wood → 2 Planks (Wood to Plank recipe)
            {
                inputs: [
                    [6], [null], [null],  // Row 1: Wood
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 13,  // Plank
                outputAmount: 2
            },
            // 2 Planks → 1 Stick
            {
                inputs: [
                    [13, 13], [null], [null],  // Row 1: 2 Planks
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 15,  // Stick
                outputAmount: 1
            },
            // 1 Plank → 1 Paper
            {
                inputs: [
                    [13], [null], [null],  // Row 1: Plank
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 14,  // Paper
                outputAmount: 1
            },
            // 1 Paper + 1 Stick → 1 Scroll
            {
                inputs: [
                    [14, 15], [null], [null],  // Row 1: Paper, Stick
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 16,  // Scroll
                outputAmount: 1
            },
            // 2 Pork → Leather Boots
            {
                inputs: [
                    [17, 17], [null], [null],  // Row 1: 2 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 21,  // Leather Boots
                outputAmount: 1
            },
            // 3 Pork → Leather Leggings
            {
                inputs: [
                    [17, 17, 17], [null], [null],  // Row 1: 3 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 20,  // Leather Leggings
                outputAmount: 1
            },
            // 4 Pork → Leather Helmet
            {
                inputs: [
                    [17, 17, 17, 17], [null], [null],  // Row 1: 4 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 18,  // Leather Helmet
                outputAmount: 1
            },
            // 5 Pork → Leather Chestplate
            {
                inputs: [
                    [17, 17, 17, 17, 17], [null], [null],  // Row 1: 5 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 19,  // Leather Chestplate
                outputAmount: 1
            },
            // 2 Stone + 1 Stick → Stone Sword
            {
                inputs: [
                    [3, 3, 15], [null], [null],  // Row 1: 2 Stone, 1 Stick
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 22,  // Stone Sword
                outputAmount: 1
            }
        ];
        
        // Collect items in crafting grid (ignore empty slots)
        const craftedItems = this._craftingGrid.filter(item => item && item.type);
        
        // Try to match recipes
        for (const recipe of recipes) {
            if (this.matchesRecipe(recipe)) {
                return recipe;
            }
        }
        
        return null;
    }

    matchesRecipe(recipe) {
        // Simple recipe matching: check if any of the crafting inputs contain items
        // This is a simplified matching system
        
        if (!this._craftingGrid) return false;
        
        // For now, just check if we have at least one wood or plank in the grid
        // and match the exact recipe configuration
        
        let hasWood = false;
        let hasPlank = false;
        let hasPaper = false;
        let hasStick = false;
        let hasPork = false;
        let hasStone = false;
        let woodCount = 0;
        let plankCount = 0;
        let paperCount = 0;
        let stickCount = 0;
        let porkCount = 0;
        let stoneCount = 0;
        
        for (let i = 0; i < this._craftingGrid.length; i++) {
            const item = this._craftingGrid[i];
            if (item && typeof item === 'object') {
                if (item.type === 6) { // Wood
                    hasWood = true;
                    woodCount += item.amount || 1;
                }
                if (item.type === 13) { // Plank
                    hasPlank = true;
                    plankCount += item.amount || 1;
                }
                if (item.type === 14) { // Paper
                    hasPaper = true;
                    paperCount += item.amount || 1;
                }
                if (item.type === 15) { // Stick
                    hasStick = true;
                    stickCount += item.amount || 1;
                }
                if (item.type === 17) { // Pork
                    hasPork = true;
                    porkCount += item.amount || 1;
                }
                if (item.type === 3) { // Stone
                    hasStone = true;
                    stoneCount += item.amount || 1;
                }
            }
        }
        
        // Wood → Plank recipe (1 wood = 2 planks)
        if (recipe.result === 13 && hasWood && woodCount > 0) {
            return true;
        }
        
        // 2 Planks → Stick recipe
        if (recipe.result === 15 && hasPlank && plankCount >= 2) {
            return true;
        }
        
        // Plank → Paper recipe (1 plank = 1 paper)
        if (recipe.result === 14 && hasPlank && plankCount > 0) {
            return true;
        }
        
        // Paper + Stick → Scroll recipe
        if (recipe.result === 16 && hasPaper && hasStick && paperCount > 0 && stickCount > 0) {
            return true;
        }
        
        // 2 Pork → Leather Boots
        if (recipe.result === 21 && hasPork && porkCount >= 2) {
            return true;
        }
        
        // 3 Pork → Leather Leggings
        if (recipe.result === 20 && hasPork && porkCount >= 3) {
            return true;
        }
        
        // 4 Pork → Leather Helmet
        if (recipe.result === 18 && hasPork && porkCount >= 4) {
            return true;
        }
        
        // 5 Pork → Leather Chestplate
        if (recipe.result === 19 && hasPork && porkCount >= 5) {
            return true;
        }
        
        // 2 Stone + 1 Stick → Stone Sword
        if (recipe.result === 22 && hasStone && hasStick && stoneCount >= 2 && stickCount >= 1) {
            return true;
        }
        
        return false;
    }

    craftItem() {
        // Execute the current crafting recipe
        if (!this.survivalMode || !this._craftingGrid) return;
        
        const recipe = this.checkCraftingRecipe();
        if (!recipe) {
            console.log('No valid recipe matched');
            return;
        }
        
        // Consume inputs from crafting grid
        if (recipe.result === 13 && recipe.outputAmount === 2) {
            // Wood → Plank recipe: consume wood, produce 2 planks
            let consumed = false;
            for (let i = 0; i < this._craftingGrid.length; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 6) {
                    // Found wood, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed = true;
                    break;
                }
            }
            
            if (!consumed) {
                console.log('Could not consume wood');
                return;
            }
            
            // Add 2 planks to inventory
            this.addToInventory(13, 2);
            console.log('Crafted 2 Planks from 1 Wood');
        } else if (recipe.result === 15 && recipe.outputAmount === 1) {
            // 2 Planks → Stick recipe: consume 2 planks, produce 1 stick
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 2; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 13) {
                    // Found plank, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            
            if (consumed < 2) {
                console.log('Could not consume 2 planks');
                return;
            }
            
            // Add 1 stick to inventory
            this.addToInventory(15, 1);
            console.log('Crafted 1 Stick from 2 Planks');
        } else if (recipe.result === 14 && recipe.outputAmount === 1) {
            // Plank → Paper recipe: consume 1 plank, produce 1 paper
            let consumed = false;
            for (let i = 0; i < this._craftingGrid.length; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 13) {
                    // Found plank, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed = true;
                    break;
                }
            }
            
            if (!consumed) {
                console.log('Could not consume plank');
                return;
            }
            
            // Add 1 paper to inventory
            this.addToInventory(14, 1);
            console.log('Crafted 1 Paper from 1 Plank');
        } else if (recipe.result === 16 && recipe.outputAmount === 1) {
            // Paper + Stick → Scroll recipe: consume 1 paper and 1 stick, produce 1 scroll
            let consumedPaper = false;
            let consumedStick = false;
            
            for (let i = 0; i < this._craftingGrid.length; i++) {
                const item = this._craftingGrid[i];
                if (!consumedPaper && item && item.type === 14) {
                    // Found paper, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumedPaper = true;
                } else if (!consumedStick && item && item.type === 15) {
                    // Found stick, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumedStick = true;
                }
                
                if (consumedPaper && consumedStick) break;
            }
            
            if (!consumedPaper || !consumedStick) {
                console.log('Could not consume paper and stick');
                return;
            }
            
            // Add 1 scroll to inventory
            this.addToInventory(16, 1);
            console.log('Crafted 1 Scroll from 1 Paper and 1 Stick');
        } else if (recipe.result === 21 && recipe.outputAmount === 1) {
            // 2 Pork → Leather Boots
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 2; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 2) return;
            this.addToInventory(21, 1);
            console.log('Crafted Leather Boots from 2 Pork');
        } else if (recipe.result === 20 && recipe.outputAmount === 1) {
            // 3 Pork → Leather Leggings
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 3; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 3) return;
            this.addToInventory(20, 1);
            console.log('Crafted Leather Leggings from 3 Pork');
        } else if (recipe.result === 18 && recipe.outputAmount === 1) {
            // 4 Pork → Leather Helmet
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 4; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 4) return;
            this.addToInventory(18, 1);
            console.log('Crafted Leather Helmet from 4 Pork');
        } else if (recipe.result === 19 && recipe.outputAmount === 1) {
            // 5 Pork → Leather Chestplate
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 5; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 5) return;
            this.addToInventory(19, 1);
            console.log('Crafted Leather Chestplate from 5 Pork');
        } else if (recipe.result === 22 && recipe.outputAmount === 1) {
            // 2 Stone + 1 Stick → Stone Sword
            let stoneConsumed = 0;
            let stickConsumed = 0;
            for (let i = 0; i < this._craftingGrid.length && (stoneConsumed < 2 || stickConsumed < 1); i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 3 && stoneConsumed < 2) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    stoneConsumed++;
                } else if (item && item.type === 15 && stickConsumed < 1) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    stickConsumed++;
                }
            }
            if (stoneConsumed < 2 || stickConsumed < 1) return;
            this.addToInventory(22, 1);
            console.log('Crafted Stone Sword from 2 Stone and 1 Stick');
        }
        
        this.updateInventoryUI();
    }

    addToInventory(blockType, amount) {
        // Add items to inventory with stacking
        let remaining = amount;
        
        // First, try to add to existing stacks
        for (let i = 0; i < this.player.inventory.length && remaining > 0; i++) {
            const item = this.player.inventory[i];
            if (item && typeof item === 'object' && item.type === blockType && item.amount < 99) {
                const space = 99 - item.amount;
                const toAdd = Math.min(space, remaining);
                item.amount += toAdd;
                remaining -= toAdd;
            }
        }
        
        // Then, fill empty slots
        for (let i = 0; i < this.player.inventory.length && remaining > 0; i++) {
            if (this.player.inventory[i] === 0) {
                const toAdd = Math.min(99, remaining);
                this.player.inventory[i] = { type: blockType, amount: toAdd };
                remaining -= toAdd;
            }
        }
        
        if (remaining > 0) {
            console.log(`Inventory full! ${remaining} blocks were not added.`);
        }
    }

    setCrosshairProgress(progress) {
        const p = Math.max(0, Math.min(1, progress || 0));
        if (this.crosshairProgress === p) return;
        this.crosshairProgress = p;

        if (!this._crosshairEl) {
            this._crosshairEl = document.getElementById('crosshair');
        }
        if (!this._crosshairEl) return;

        if (p === 0) {
            this._crosshairEl.style.background = 'transparent';
            this._crosshairEl.style.borderColor = 'rgba(255,255,255,0.5)';
        } else {
            const deg = (p * 360).toFixed(1);
            this._crosshairEl.style.background = `conic-gradient(rgba(120,170,255,0.85) ${deg}deg, rgba(255,255,255,0.05) ${deg}deg)`;
            this._crosshairEl.style.borderColor = '#8fb7ff';
        }
    }

    updateBreakProgress() {
        if (this.pendingBreak && this.pendingBreak.startTime && this.pendingBreak.duration) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const elapsed = now - this.pendingBreak.startTime;
            const p = Math.max(0, Math.min(1, elapsed / this.pendingBreak.duration));
            this.setCrosshairProgress(p);
            return;
        }
        this.setCrosshairProgress(0);
    }

    getBreakDuration(blockType) {
        // Base break time: 4 seconds
        let duration = 4000;
        // If a chisel is equipped in the Tool slot, speed up breaking (50% time)
        try {
            const tool = this.player && this.player.equipment ? this.player.equipment.tool : 0;
            const hasChisel = (tool && typeof tool === 'object' && tool.type === 30) || tool === 30;
            if (hasChisel) duration *= 0.5; // 2 seconds with chisel
        } catch {}
        return duration;
    }

    giveCreativeItem(blockType, amount = 64) {
        // Add item stack to inventory and sync hotbar selection for creative picks
        this.addToInventory(blockType, amount);
        this.updateInventoryUI();

        // Ensure hotbar reflects the chosen item for immediate use
        const slots = document.querySelectorAll('.hotbar-slot');
        if (slots && slots.length) {
            const idx = this.hotbarIndex || 0;
            const slot = slots[idx];
            slot.dataset.block = blockType;
            slot.textContent = this.blockNames[blockType] || '';
            this.hotbarIndex = idx;
            this.player.selectedBlock = blockType;
            this.updateHotbar();
        } else {
            this.player.selectedBlock = blockType;
        }
    }

    canCraftRecipe(recipe) {
        // Check if inventory has all required items for this recipe
        const needed = { ...recipe.inputs };
        const inventory = this.player.inventory;

        for (const [typeStr, amount] of Object.entries(needed)) {
            const type = Number(typeStr);
            let found = 0;

            for (let i = 0; i < inventory.length; i++) {
                const item = inventory[i];
                if (item && typeof item === 'object' && item.type === type) {
                    found += item.amount || 1;
                    if (found >= amount) break;
                }
            }

            if (found < amount) return false;
        }

        return true;
    }

    craftRecipe(recipe) {
        // Consume items from inventory and add crafted result
        if (!this.survivalMode) return;

        // Check if we can craft
        if (!this.canCraftRecipe(recipe)) {
            console.log('Cannot craft: missing required items');
            return;
        }

        // Consume items from inventory
        const needed = { ...recipe.inputs };
        const inventory = this.player.inventory;

        for (const [typeStr, amount] of Object.entries(needed)) {
            const type = Number(typeStr);
            let remaining = amount;

            for (let i = 0; i < inventory.length && remaining > 0; i++) {
                const item = inventory[i];
                if (item && typeof item === 'object' && item.type === type) {
                    const toConsume = Math.min(item.amount, remaining);
                    item.amount -= toConsume;
                    remaining -= toConsume;

                    if (item.amount <= 0) {
                        inventory[i] = 0;
                    }
                }
            }
        }

        // Add crafted item to inventory
        this.addToInventory(recipe.result, recipe.resultAmount);
        console.log(`Crafted ${recipe.name}`);
        this.updateInventoryUI();
    }


    toggleInventory() {
        this.createInventoryUI();
        if (!this._inventoryEl) this.createInventoryUI();
        const open = this._inventoryEl.style.display !== 'block';
        this._inventoryEl.style.display = open ? 'block' : 'none';
        this.inventoryOpen = open;
        if (open) {
            // show mouse
            try { document.exitPointerLock(); } catch (e) {}
            this.setCrosshairProgress(0);
            } else {
                // close inventory: try re-lock pointer for convenience
                // Also close container UIs so block breaking works again
                if (this.openChestPos) this.closeChestUI();
                if (this.opencandlePos) this.closecandleUI();
                if (this.openCauldronPos) this.closecauldronUI();
                try {
                    const el = this.renderer && this.renderer.domElement;
                    if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
                } catch (e) {}
            }
    }

    createPauseMenu() {
        if (this._pauseMenuEl) return;

        const menu = document.createElement('div');
        menu.id = 'pause-menu';
        menu.style.position = 'absolute';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        menu.style.padding = '32px';
        menu.style.background = 'rgba(0,0,0,0.9)';
        menu.style.border = '3px solid #666';
        menu.style.borderRadius = '12px';
        menu.style.display = 'none';
        menu.style.zIndex = '200';
        menu.style.minWidth = '300px';
        menu.style.textAlign = 'center';

        const title = document.createElement('h2');
        title.textContent = 'Game Paused';
        title.style.color = '#fff';
        title.style.marginTop = '0';
        title.style.marginBottom = '24px';
        title.style.fontFamily = 'Arial, sans-serif';
        menu.appendChild(title);

        const buttonStyle = {
            width: '100%',
            padding: '12px',
            margin: '8px 0',
            fontSize: '16px',
            fontWeight: 'bold',
            background: 'rgba(255,255,255,0.1)',
            border: '2px solid #888',
            borderRadius: '6px',
            color: '#fff',
            cursor: 'pointer',
            fontFamily: 'Arial, sans-serif',
            transition: 'all 0.2s'
        };

        // Resume button
        const resumeBtn = document.createElement('button');
        resumeBtn.textContent = 'Resume';
        Object.assign(resumeBtn.style, buttonStyle);
        resumeBtn.addEventListener('mouseenter', () => {
            resumeBtn.style.background = 'rgba(255,255,255,0.2)';
            resumeBtn.style.borderColor = '#aaa';
        });
        resumeBtn.addEventListener('mouseleave', () => {
            resumeBtn.style.background = 'rgba(255,255,255,0.1)';
            resumeBtn.style.borderColor = '#888';
        });
        resumeBtn.addEventListener('click', () => this.togglePauseMenu());
        menu.appendChild(resumeBtn);

        // Save World button
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save World';
        Object.assign(saveBtn.style, buttonStyle);
        saveBtn.addEventListener('mouseenter', () => {
            saveBtn.style.background = 'rgba(100,200,100,0.3)';
            saveBtn.style.borderColor = '#6c6';
        });
        saveBtn.addEventListener('mouseleave', () => {
            saveBtn.style.background = 'rgba(255,255,255,0.1)';
            saveBtn.style.borderColor = '#888';
        });
        saveBtn.addEventListener('click', () => {
            this.showSaveSlotMenu((slot) => {
                this.saveWorld(slot);
                saveBtn.textContent = `Saved to Slot ${slot}!`;
                setTimeout(() => { saveBtn.textContent = 'Save World'; }, 1200);
            });
        });
        menu.appendChild(saveBtn);

        // Exit button
        const exitBtn = document.createElement('button');
        exitBtn.textContent = 'Exit to Main Menu';
        Object.assign(exitBtn.style, buttonStyle);
        exitBtn.addEventListener('mouseenter', () => {
            exitBtn.style.background = 'rgba(200,100,100,0.3)';
            exitBtn.style.borderColor = '#c66';
        });
        exitBtn.addEventListener('mouseleave', () => {
            exitBtn.style.background = 'rgba(255,255,255,0.1)';
            exitBtn.style.borderColor = '#888';
        });
        exitBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to exit? Unsaved progress will be lost.')) {
                window.location.reload();
            }
        });
        menu.appendChild(exitBtn);

        document.body.appendChild(menu);
        this._pauseMenuEl = menu;
    }

    togglePauseMenu() {
        this.createPauseMenu();
        const open = this._pauseMenuEl.style.display !== 'block';
        this._pauseMenuEl.style.display = open ? 'block' : 'none';
        this.pauseMenuOpen = open;
        if (open) {
            // Show mouse and close inventory if open
            if (this._inventoryEl && this._inventoryEl.style.display === 'block') {
                this._inventoryEl.style.display = 'none';
                this.inventoryOpen = false;
            }
            // Close chest UI if open
            if (this.openChestPos) {
                this.closeChestUI();
            }
            if (this.opencandlePos) {
                this.closecandleUI();
            }
            if (this.openCauldronPos) {
                this.closecauldronUI();
            }
            try { document.exitPointerLock(); } catch (e) {}
        } else {
            // Resume: re-lock pointer
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
            } catch (e) {}
        }
    }

    createCreativeMenu() {
        // If we previously created the element but it was removed from the DOM
        // (unlikely but possible), treat it as not existing so we recreate it.
        if (this._creativeMenuEl && document.body.contains(this._creativeMenuEl)) return;
        this._creativeMenuEl = null; // allow rebuild

        const menu = document.createElement('div');
        menu.id = 'creative-menu';
        menu.style.position = 'absolute';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        menu.style.padding = '20px';
        menu.style.background = 'rgba(0,0,0,0.9)';
        menu.style.border = '3px solid #666';
        menu.style.borderRadius = '12px';
        menu.style.display = 'none';
        menu.style.zIndex = '150';
        menu.style.maxHeight = '80vh';
        menu.style.overflowY = 'auto';

        const title = document.createElement('h2');
        title.textContent = 'Creative Blocks';
        title.style.color = '#fff';
        title.style.marginTop = '0';
        title.style.marginBottom = '16px';
        title.style.fontFamily = 'Arial, sans-serif';
        menu.appendChild(title);

        // Block grid
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(6, 60px)';
        grid.style.gridGap = '8px';
        grid.style.marginBottom = '16px';

        // Add all non-air entries from blockNames so new items (coal, torch, chest, mana orb, magic candle, etc)
        // show up automatically.  However only blocks the player can actually place
        // are useful in the creative block picker – selecting an unplaceable item
        // would lead to the "i can't place" confusion the player reported.  We
        // still allow the game to give non-placeable items via other code (e.g.
        // recipes) but the creative menu only shows block types that pass
        // `isBlockPlaceable`.
        const blockTypes = Object.keys(this.blockNames)
            .map(Number)
            .filter(t => t > 0)
            .sort((a, b) => a - b);

        blockTypes.forEach(blockType => {
            const blockBtn = document.createElement('button');
            const blockName = this.blockNames[blockType] || 'Block ' + blockType;
            blockBtn.textContent = blockName;
            blockBtn.style.padding = '12px';
            blockBtn.style.background = 'rgba(100,100,150,0.5)';
            blockBtn.style.border = '2px solid #555';
            blockBtn.style.borderRadius = '6px';
            blockBtn.style.color = '#fff';
            blockBtn.style.cursor = 'pointer';
            blockBtn.style.fontFamily = 'Arial, sans-serif';
            blockBtn.style.fontSize = '12px';
            blockBtn.style.transition = 'all 0.2s';

            blockBtn.addEventListener('mouseenter', () => {
                blockBtn.style.background = 'rgba(100,200,100,0.6)';
                blockBtn.style.borderColor = '#8f8';
            });
            blockBtn.addEventListener('mouseleave', () => {
                blockBtn.style.background = 'rgba(100,100,150,0.5)';
                blockBtn.style.borderColor = '#555';
            });
            blockBtn.addEventListener('click', () => {
                // Give stack to inventory and sync hotbar
                this.giveCreativeItem(blockType, 64);
                menu.style.display = 'none';
                this.creativeMenuOpen = false;
                // Re-lock pointer
                try {
                    const el = this.renderer && this.renderer.domElement;
                    if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
                } catch (e) {}
            });

            grid.appendChild(blockBtn);
        });

        menu.appendChild(grid);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close (C)';
        closeBtn.style.width = '100%';
        closeBtn.style.padding = '12px';
        closeBtn.style.background = 'rgba(150,100,100,0.5)';
        closeBtn.style.border = '2px solid #888';
        closeBtn.style.borderRadius = '6px';
        closeBtn.style.color = '#fff';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontFamily = 'Arial, sans-serif';
        closeBtn.style.fontSize = '14px';
        closeBtn.style.transition = 'all 0.2s';

        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(200,100,100,0.6)';
            closeBtn.style.borderColor = '#caa';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(150,100,100,0.5)';
            closeBtn.style.borderColor = '#888';
        });
        closeBtn.addEventListener('click', () => this.toggleCreativeMenu());

        menu.appendChild(closeBtn);

        document.body.appendChild(menu);
        this._creativeMenuEl = menu;
    }

    toggleCreativeMenu() {
        if (this.survivalMode) {
            console.log('Creative menu is disabled in survival mode.');
            return; // Don't allow in survival mode
        }
        this.createCreativeMenu();
        if (!this._creativeMenuEl) {
            console.warn('Failed to create creative menu element');
            return;
        }
        const open = this._creativeMenuEl.style.display !== 'block';
        this._creativeMenuEl.style.display = open ? 'block' : 'none';
        this.creativeMenuOpen = open;
        console.log(open ? 'Creative menu opened' : 'Creative menu closed');
        if (open) {
            // Show mouse and close other menus if open
            if (this._inventoryEl && this._inventoryEl.style.display === 'block') {
                this._inventoryEl.style.display = 'none';
                this.inventoryOpen = false;
            }
            if (this._pauseMenuEl && this._pauseMenuEl.style.display === 'block') {
                this._pauseMenuEl.style.display = 'none';
                this.pauseMenuOpen = false;
            }
            try { document.exitPointerLock(); } catch (e) {}
        } else {
            // Close: re-lock pointer
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
            } catch (e) {}
        }
    }

    // ------- Creative Mob Spawn Menu (V) -------
    createSpawnMenu() {
        if (this._spawnMenuEl) return;

        const menu = document.createElement('div');
        menu.id = 'spawn-menu';
        menu.style.position = 'absolute';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        menu.style.padding = '20px';
        menu.style.background = 'rgba(0,0,0,0.9)';
        menu.style.border = '3px solid #666';
        menu.style.borderRadius = '12px';
        menu.style.display = 'none';
        menu.style.zIndex = '160';
        menu.style.maxHeight = '70vh';
        menu.style.overflowY = 'auto';

        const title = document.createElement('h2');
        title.textContent = 'Mob Spawner';
        title.style.color = '#fff';
        title.style.marginTop = '0';
        title.style.marginBottom = '16px';
        title.style.fontFamily = 'Arial, sans-serif';
        menu.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(2, 180px)';
        grid.style.gridGap = '10px';
        grid.style.marginBottom = '16px';

        const makeBtn = (label, onClick) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.style.padding = '12px';
            btn.style.background = 'rgba(100,100,150,0.5)';
            btn.style.border = '2px solid #555';
            btn.style.borderRadius = '6px';
            btn.style.color = '#fff';
            btn.style.cursor = 'pointer';
            btn.style.fontFamily = 'Arial, sans-serif';
            btn.style.fontSize = '14px';
            btn.style.transition = 'all 0.2s';
            btn.addEventListener('mouseenter', () => {
                btn.style.background = 'rgba(100,200,100,0.6)';
                btn.style.borderColor = '#8f8';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'rgba(100,100,150,0.5)';
                btn.style.borderColor = '#555';
            });
            btn.addEventListener('click', () => {
                try { onClick(); } catch (e) { console.warn('Spawn action failed', e); }
            });
            return btn;
        };

        // Spawn piggron near player
        grid.appendChild(makeBtn('Spawn piggron (near player)', () => {
            const px = this.player.position.x;
            const pz = this.player.position.z;
            const pig = this.spawnpiggronAt(px, pz);
            if (!pig) console.log('piggron spawn failed (invalid surface?)');
        }));

        // Spawn Slime near player (use terrain height)
        grid.appendChild(makeBtn('Spawn Slime (near player)', () => {
            if (!this.world) return;
            const px = this.player.position.x;
            const pz = this.player.position.z;
            const y = this.world.getTerrainHeight(Math.floor(px), Math.floor(pz));
            const s = this.spawnSlimeAt(px, pz);
            if (!s) console.log('Slime spawn failed');
        }));

        // Spawn Minotaur near player (use terrain height)
        grid.appendChild(makeBtn('Spawn Minotaur (near player)', () => {
            if (!this.world) return;
            const px = this.player.position.x;
            const pz = this.player.position.z;
            const y = this.world.getTerrainHeight(Math.floor(px), Math.floor(pz));
            const m = this.spawnMinutorAt(px, y, pz);
            if (!m) console.log('Minotaur spawn failed');
        }));

        // Spawn piggron Priest (uses predefined location)
        grid.appendChild(makeBtn('Spawn piggron Priest (cathedral)', () => {
            this.spawnpiggronPriest();
        }));

        // Optional: Despawn all pigmen/minotaurs
        grid.appendChild(makeBtn('Despawn All Mobs', () => {
            // Remove pigmen
            if (this.squirrels && this.scene) {
                this.squirrels.forEach(s => { if (s.mesh) this.scene.remove(s.mesh); });
                this.squirrels = [];
            }
            if (this.pigmen && this.scene) {
                this.pigmen.forEach(p => { if (p.mesh) this.scene.remove(p.mesh); });
                this.pigmen = [];
            }
            // Remove slimes
            if (this.slimes && this.scene) {
                this.slimes.forEach(s => { if (s.mesh) this.scene.remove(s.mesh); });
                this.slimes = [];
            }
            // Remove minutors
            if (this.minutors && this.scene) {
                this.minutors.forEach(m => { if (m.mesh) this.scene.remove(m.mesh); });
                this.minutors = [];
            }
            // Remove priest
            if (this.piggronPriest && this.piggronPriest.mesh && this.scene) {
                this.scene.remove(this.piggronPriest.mesh);
                this.piggronPriest = null;
            }
            console.log('All mobs despawned');
        }));

        menu.appendChild(grid);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close (V)';
        closeBtn.style.width = '100%';
        closeBtn.style.padding = '12px';
        closeBtn.style.background = 'rgba(150,100,100,0.5)';
        closeBtn.style.border = '2px solid #888';
        closeBtn.style.borderRadius = '6px';
        closeBtn.style.color = '#fff';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontFamily = 'Arial, sans-serif';
        closeBtn.style.fontSize = '14px';
        closeBtn.style.transition = 'all 0.2s';
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(200,100,100,0.6)';
            closeBtn.style.borderColor = '#caa';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(150,100,100,0.5)';
            closeBtn.style.borderColor = '#888';
        });
        closeBtn.addEventListener('click', () => this.toggleSpawnMenu());

        menu.appendChild(closeBtn);

        document.body.appendChild(menu);
        this._spawnMenuEl = menu;
    }

    toggleSpawnMenu() {
        if (this.survivalMode) return; // Creative-only
        this.createSpawnMenu();
        const open = this._spawnMenuEl.style.display !== 'block';
        this._spawnMenuEl.style.display = open ? 'block' : 'none';
        this.spawnMenuOpen = open;
        if (open) {
            // Close other menus and show mouse
            if (this._inventoryEl && this._inventoryEl.style.display === 'block') {
                this._inventoryEl.style.display = 'none';
                this.inventoryOpen = false;
            }
            if (this._pauseMenuEl && this._pauseMenuEl.style.display === 'block') {
                this._pauseMenuEl.style.display = 'none';
                this.pauseMenuOpen = false;
            }
            if (this._creativeMenuEl && this._creativeMenuEl.style.display === 'block') {
                this._creativeMenuEl.style.display = 'none';
                this.creativeMenuOpen = false;
            }
            try { document.exitPointerLock(); } catch (e) {}
        } else {
            // Re-lock pointer on close
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
            } catch (e) {}
        }
    }

    createChatUI() {
        if (this.chatLogEl) return;

        // log container
        const log = document.createElement('div');
        log.id = 'chat-log';
        log.style.position = 'absolute';
        log.style.bottom = '60px';
        log.style.left = '20px';
        log.style.width = '300px';
        log.style.maxHeight = '200px';
        log.style.overflowY = 'auto';
        log.style.background = 'rgba(0,0,0,0.5)';
        log.style.color = '#fff';
        log.style.fontFamily = 'Arial, sans-serif';
        log.style.fontSize = '12px';
        log.style.padding = '4px';
        log.style.zIndex = '200';
        document.body.appendChild(log);
        this.chatLogEl = log;

        // input field hidden initially
        const input = document.createElement('input');
        input.id = 'chat-input';
        input.type = 'text';
        input.style.position = 'absolute';
        input.style.bottom = '20px';
        input.style.left = '20px';
        input.style.width = '300px';
        input.style.display = 'none';
        input.style.padding = '6px';
        input.style.fontFamily = 'Arial, sans-serif';
        input.style.fontSize = '14px';
        input.style.zIndex = '200';
        document.body.appendChild(input);
        this.chatInputEl = input;

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const text = input.value.trim();
                if (text) {
                    const handled = this.handleChatCommand(text);
                    if (!handled) {
                        if (this.ws && this.ws.readyState === 1) {
                            this.ws.send(JSON.stringify({ type: 'chat', text }));
                        }
                        this.addChatMessage(`${this.playerName}: ${text}`);
                        // Add to history (only user sent messages)
                        this.chatHistory.push(text);
                    }
                }
                input.value = '';
                this.chatHistoryIndex = -1;
                input.style.display = 'none';
                this.chatActive = false;
                e.preventDefault();
            } else if (e.key === 'Escape') {
                input.value = '';
                this.chatHistoryIndex = -1;
                input.style.display = 'none';
                this.chatActive = false;
                e.preventDefault();
            } else if (e.key === 'ArrowUp') {
                // Scroll through chat history (older messages)
                if (this.chatHistory.length === 0) return;
                e.preventDefault();
                if (this.chatHistoryIndex < this.chatHistory.length - 1) {
                    this.chatHistoryIndex++;
                    const historyLength = this.chatHistory.length;
                    input.value = this.chatHistory[historyLength - 1 - this.chatHistoryIndex];
                    // Move cursor to end
                    setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
                }
            } else if (e.key === 'ArrowDown') {
                // Scroll through chat history (newer messages)
                e.preventDefault();
                if (this.chatHistoryIndex > 0) {
                    this.chatHistoryIndex--;
                    const historyLength = this.chatHistory.length;
                    input.value = this.chatHistory[historyLength - 1 - this.chatHistoryIndex];
                    // Move cursor to end
                    setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
                } else if (this.chatHistoryIndex === 0) {
                    this.chatHistoryIndex = -1;
                    input.value = '';
                }
            }
        });
    }

    getCurrentDimensionKey() {
        if (this.inAstralDimension) return 'astral';
        if (this.world && this.world.worldType === 'fairia') return 'fairia';
        return 'default';
    }

    hasItemTypeInInventory(type) {
        if (!this.player || !this.player.inventory) return false;
        for (let i = 0; i < this.player.inventory.length; i++) {
            const item = this.player.inventory[i];
            if (!item || item === 0) continue;
            const itemType = this.getItemTypeValue(item);
            if (itemType === type) return true;
        }
        return false;
    }

    hasLevelKey(level = 1) {
        if (level === 1) return this.hasItemTypeInInventory(this.LV1_KEY_TYPE);
        return false;
    }

    consumeItemTypeFromInventory(type, amount = 1) {
        if (!this.player || !this.player.inventory) return false;

        let remaining = Math.max(1, Math.floor(Number(amount) || 1));
        for (let i = 0; i < this.player.inventory.length && remaining > 0; i++) {
            const item = this.player.inventory[i];
            if (!item || item === 0) continue;

            const itemType = this.getItemTypeValue(item);
            if (itemType !== type) continue;

            if (typeof item === 'object') {
                const itemAmount = Math.max(1, Math.floor(Number(item.amount) || 1));
                const used = Math.min(itemAmount, remaining);
                item.amount = itemAmount - used;
                remaining -= used;
                if (item.amount <= 0) this.player.inventory[i] = 0;
            } else {
                this.player.inventory[i] = 0;
                remaining -= 1;
            }
        }

        const consumed = remaining === 0;
        if (consumed) this.updateInventoryUI();
        return consumed;
    }

    consumeLevelKey(level = 1) {
        if (level === 1) return this.consumeItemTypeFromInventory(this.LV1_KEY_TYPE, 1);
        return false;
    }

    createAstralLockedCathedralChest() {
        if (!this.world || this.world.worldType !== 'astral') return;

        const layout = (typeof this.world.getAstralLayout === 'function') ? this.world.getAstralLayout() : null;
        if (!layout) return;

        const baseX = Math.round(layout.cathedralCenterX);
        const baseZ = Math.round(layout.cathedralCenterZ);
        const minY = layout.cathedralAnchorY + 1;
        const maxY = layout.cathedralAnchorY + 8;

        const offsets = [
            [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2]
        ];

        let found = null;
        for (const [ox, oz] of offsets) {
            const x = baseX + ox;
            const z = baseZ + oz;
            for (let y = minY; y <= maxY; y++) {
                const floor = this.world.getBlock(x, y - 1, z);
                const body = this.world.getBlock(x, y, z);
                if (this.world.isBlockSolid(floor) && body === 0) {
                    found = { x, y, z };
                    break;
                }
            }
            if (found) break;
        }

        if (!found) return;

        this.world.setBlock(found.x, found.y, found.z, 26);
        const key = `${found.x},${found.y},${found.z}`;
        this.cathedralLockedChestKey = key;
        this.lockedChests.set(key, { keyLevel: 1 });

        const cx = Math.floor(found.x / this.world.chunkSize);
        const cz = Math.floor(found.z / this.world.chunkSize);
        this.updateChunkMesh(cx, cz);
        console.log(`Placed locked cathedral chest at ${key}`);
    }

    addMapWaypoint(label = '') {
        if (!this.player) return;
        const dimensionKey = this.getCurrentDimensionKey();
        if (!this.mapWaypoints) {
            this.mapWaypoints = { default: [], fairia: [], astral: [] };
        }
        const list = this.mapWaypoints[dimensionKey] || (this.mapWaypoints[dimensionKey] = []);
        const trimmedLabel = String(label || '').trim();
        list.push({
            x: this.player.position.x,
            z: this.player.position.z,
            label: trimmedLabel,
            timestamp: Date.now()
        });
        if (list.length > 16) list.shift();

        const name = trimmedLabel ? `Waypoint added: ${trimmedLabel}` : 'Waypoint added to minimap';
        this.addChatMessage(`[System] ${name}`);
        this.updateMinimap();
    }

    isContainerAccessoryType(type) {
        return type === this.LIFE_CONTANER_TYPE || type === this.ENERGY_VESSEIL_TYPE;
    }

    getAccessorySlots() {
        return ['accessory1', 'accessory2', 'accessory3', 'accessory4', 'accessory5', 'accessory6', 'accessory7'];
    }

    canEquipItemInSlot(slotKey, item) {
        const itemType = this.getItemTypeValue(item);
        if (!itemType) return false;
        if (!slotKey || !slotKey.startsWith('accessory')) return true;
        if (!this.isContainerAccessoryType(itemType)) return true;

        const slots = this.getAccessorySlots();
        for (const key of slots) {
            if (key === slotKey) continue;
            const existing = this.player.equipment[key];
            if (this.getItemTypeValue(existing) === itemType) return false;
        }
        return true;
    }

    applyContainerAccessoryBonuses() {
        if (!this.player) return;

        const baseHp = Math.max(10, Math.min(50, Number(this.player.baseMaxHealth) || 10));
        const baseAp = Math.max(5, Math.min(50, Number(this.player.baseMaxAP) || 5));
        this.player.baseMaxHealth = baseHp;
        this.player.baseMaxAP = baseAp;

        const hasLife = this.player.hasAccessoryEquipped(this.LIFE_CONTANER_TYPE);
        const hasEnergy = this.player.hasAccessoryEquipped(this.ENERGY_VESSEIL_TYPE);

        this.player.maxHealth = baseHp + (hasLife ? 10 : 0);
        this.player.maxAP = baseAp + (hasEnergy ? 10 : 0);
        this.player.health = Math.min(this.player.health, this.player.maxHealth);
        this.player.ap = Math.min(this.player.ap, this.player.maxAP);

        this.updateHealthBar();
        this.updateAPBar();
    }

    equipContainerAccessoryFromInventorySlot(slotIndex, itemType) {
        if (!this.player || !this.isContainerAccessoryType(itemType)) return false;

        const slots = this.getAccessorySlots();
        for (const key of slots) {
            if (this.getItemTypeValue(this.player.equipment[key]) === itemType) {
                console.log('You can only equip one of this accessory type.');
                return false;
            }
        }

        let targetSlot = null;
        for (const key of slots) {
            if (!this.player.equipment[key] || this.player.equipment[key] === 0) {
                targetSlot = key;
                break;
            }
        }
        if (!targetSlot) {
            console.log('No empty accessory slot available.');
            return false;
        }

        const invItem = this.player.inventory[slotIndex];
        if (!invItem || this.getItemTypeValue(invItem) !== itemType) return false;

        this.player.equipment[targetSlot] = { type: itemType, amount: 1, maxStack: 1 };

        if (typeof invItem === 'object') {
            invItem.amount = (invItem.amount || 1) - 1;
            if (invItem.amount <= 0) this.player.inventory[slotIndex] = 0;
        } else {
            this.player.inventory[slotIndex] = 0;
        }

        this.applyContainerAccessoryBonuses();
        this.updateInventoryUI();
        return true;
    }

    grantContainerRewardImmediate(itemType) {
        if (!this.player || !this.isContainerAccessoryType(itemType)) return;

        // Try immediate apply by auto-equipping if a slot is open and same type isn't already equipped.
        const slots = this.getAccessorySlots();
        let hasSameEquipped = false;
        for (const key of slots) {
            if (this.getItemTypeValue(this.player.equipment[key]) === itemType) {
                hasSameEquipped = true;
                break;
            }
        }

        if (!hasSameEquipped) {
            for (const key of slots) {
                if (!this.player.equipment[key] || this.player.equipment[key] === 0) {
                    this.player.equipment[key] = { type: itemType, amount: 1, maxStack: 1 };
                    this.applyContainerAccessoryBonuses();
                    this.updateInventoryUI();
                    return;
                }
            }

            // Keep level-up rewards immediate by replacing a non-container accessory if all slots are full.
            for (const key of slots) {
                const existing = this.player.equipment[key];
                const existingType = this.getItemTypeValue(existing);
                if (!existing || existing === 0 || this.isContainerAccessoryType(existingType)) continue;

                this.addToInventory(existingType, 1);
                this.player.equipment[key] = { type: itemType, amount: 1, maxStack: 1 };
                this.applyContainerAccessoryBonuses();
                this.updateInventoryUI();
                return;
            }
        }

        // Fallback: keep as item in inventory if immediate equip isn't possible.
        this.addToInventory(itemType, 1);
        this.updateInventoryUI();
    }

    randomTeleportPlayer() {
        if (!this.player || !this.world) return false;

        const mpCost = 1;
        if ((Number(this.player.mp) || 0) < mpCost) {
            this.addChatMessage('[System] Not enough MP for rtp (need 1 MP).');
            return false;
        }

        const edge = Math.max(16, (this.world.worldChunkRadius * this.world.chunkSize) - 4);
        const minCoord = -edge;
        const maxCoord = edge;

        let destination = null;
        for (let i = 0; i < 80; i++) {
            const wx = Math.floor(minCoord + Math.random() * (maxCoord - minCoord + 1));
            const wz = Math.floor(minCoord + Math.random() * (maxCoord - minCoord + 1));

            const floorY = Math.floor(this.world.getTerrainHeight(wx, wz));
            if (!Number.isFinite(floorY) || floorY < 1 || floorY >= (this.world.chunkHeight - 3)) continue;

            const floor = this.world.getBlock(wx, floorY, wz);
            const body = this.world.getBlock(wx, floorY + 1, wz);
            const head = this.world.getBlock(wx, floorY + 2, wz);
            if (!this.world.isBlockSolid(floor)) continue;
            if (this.world.isBlockSolid(body) || this.world.isBlockSolid(head)) continue;

            destination = { x: wx + 0.5, y: floorY + 1.1, z: wz + 0.5 };
            break;
        }

        if (!destination) {
            this.addChatMessage('[System] rtp failed: no safe location found.');
            return false;
        }

        this.player.mp = Math.max(0, (Number(this.player.mp) || 0) - mpCost);
        if (typeof this.updateMPBar === 'function') this.updateMPBar();

        this.player.position.set(destination.x, destination.y, destination.z);
        if (this.player.velocity) this.player.velocity.set(0, 0, 0);
        this.addChatMessage(`[System] Teleported to ${Math.floor(destination.x)}, ${Math.floor(destination.y)}, ${Math.floor(destination.z)} (-1 MP).`);
        this.updateMinimap();
        return true;
    }

    setGameModeFromChatCommand(enableSurvival) {
        const nextSurvival = !!enableSurvival;
        this.survivalMode = nextSurvival;
        if (this.player) {
            this.player.survivalMode = nextSurvival;
            if (!nextSurvival) {
                this.player.isDead = false;
            }
        }

        if (nextSurvival) {
            this.createHealthBar();
            this.createAPBar();
            this.createMPBar();
            this.createXPBar();
            this.createGoldDisplay();
            if (this._healthBarEl) this._healthBarEl.style.display = 'block';
            if (this._apBarEl) this._apBarEl.style.display = 'block';
            if (this._mpBarEl) this._mpBarEl.style.display = 'block';
            if (this._xpBarEl) this._xpBarEl.style.display = 'block';
            if (this._goldDisplayEl) this._goldDisplayEl.style.display = 'block';
            this.updateHealthBar();
            this.updateAPBar();
            this.updateMPBar();
            this.updateXPBar();
            this.updateGoldDisplay();
            this.addChatMessage('[System] Mode set to Survival.');
        } else {
            if (this._healthBarEl) this._healthBarEl.style.display = 'none';
            if (this._apBarEl) this._apBarEl.style.display = 'none';
            if (this._mpBarEl) this._mpBarEl.style.display = 'none';
            if (this._xpBarEl) this._xpBarEl.style.display = 'none';
            if (this._goldDisplayEl) this._goldDisplayEl.style.display = 'none';
            this.addChatMessage('[System] Mode set to Creative.');
        }

        if (nextSurvival) {
            if (this._creativeMenuEl) this._creativeMenuEl.style.display = 'none';
            if (this._spawnMenuEl) this._spawnMenuEl.style.display = 'none';
            this.creativeMenuOpen = false;
            this.spawnMenuOpen = false;
        }

        this.applyHudVisibility();
        this.initializeHotbar();
    }

    runFillCommand(rawArgs) {
        if (!this.world || !this.player) {
            this.addChatMessage('[System] Fill failed: world/player not ready.');
            return true;
        }

        const args = (rawArgs || '').trim().split(/\s+/).filter(Boolean);
        if (args.length < 7) {
            this.addChatMessage('[System] Usage: /fill <x1> <y1> <z1> <x2> <y2> <z2> <blockId> [solid|all|hollow]');
            return true;
        }

        const x1 = Number(args[0]);
        const y1 = Number(args[1]);
        const z1 = Number(args[2]);
        const x2 = Number(args[3]);
        const y2 = Number(args[4]);
        const z2 = Number(args[5]);
        const blockType = Number(args[6]);
        const modeRaw = (args[7] || 'solid').toLowerCase();
        const mode = (modeRaw === 'all' || modeRaw === 'hollow') ? modeRaw : 'solid';

        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1) ||
            !Number.isFinite(x2) || !Number.isFinite(y2) || !Number.isFinite(z2)) {
            this.addChatMessage('[System] Fill failed: coordinates must be numbers.');
            return true;
        }

        if (!Number.isFinite(blockType) || blockType < 0) {
            this.addChatMessage('[System] Fill failed: blockId must be a number >= 0.');
            return true;
        }

        const minX = Math.min(Math.floor(x1), Math.floor(x2));
        const maxX = Math.max(Math.floor(x1), Math.floor(x2));
        const minY = Math.max(0, Math.min(Math.floor(y1), Math.floor(y2)));
        const maxY = Math.min(this.world.chunkHeight - 1, Math.max(Math.floor(y1), Math.floor(y2)));
        const minZ = Math.min(Math.floor(z1), Math.floor(z2));
        const maxZ = Math.max(Math.floor(z1), Math.floor(z2));

        if (minY > maxY) {
            this.addChatMessage('[System] Fill failed: Y range is outside world bounds.');
            return true;
        }

        const sizeX = maxX - minX + 1;
        const sizeY = maxY - minY + 1;
        const sizeZ = maxZ - minZ + 1;
        const volume = sizeX * sizeY * sizeZ;
        if (volume > 250000) {
            this.addChatMessage('[System] Fill failed: area too large (max 250000 blocks).');
            return true;
        }

        let changed = 0;
        for (let wx = minX; wx <= maxX; wx++) {
            for (let wy = minY; wy <= maxY; wy++) {
                for (let wz = minZ; wz <= maxZ; wz++) {
                    const onBoundary = (wx === minX || wx === maxX || wy === minY || wy === maxY || wz === minZ || wz === maxZ);
                    if (mode === 'hollow' && !onBoundary) continue;

                    const existing = this.world.getBlock(wx, wy, wz);
                    if (mode === 'solid' && existing === 0) continue;
                    if (existing === blockType) continue;

                    this.world.setBlock(wx, wy, wz, blockType);
                    changed++;
                }
            }
        }

        this.addChatMessage(`[System] Fill ${mode} complete: ${changed} blocks changed (block ${Math.floor(blockType)} from ${minX},${minY},${minZ} to ${maxX},${maxY},${maxZ}).`);
        return true;
    }

    runBlockHelpCommand() {
        this.addChatMessage('[System] Block IDs (common):');
        this.addChatMessage('1 Dirt, 2 Grass, 3 Stone, 4 Sand, 5 Water');
        this.addChatMessage('6 Wood, 7 Bricks, 8 Ruby, 9 Clay, 10 Snow');
        this.addChatMessage('11 Leafs, 12 Sapphire, 13 Plank, 24 Coal');
        this.addChatMessage('25 Torch, 26 Chest, 29 Magic Candle');
        this.addChatMessage('33 Grim Stone, 34 Lava, 40 TNT, 42 Cauldron');
        this.addChatMessage('45 Structure Block, 46 Fairia Portal');
        this.addChatMessage('47 Wood Door, 48 Dungeon Door, 56 Connecter');
        this.addChatMessage('57-63 Rainbow Cloth, 64 Red Sconce, 65 Blue Sconce');
        this.addChatMessage('[System] Fill usage: /fill x1 y1 z1 x2 y2 z2 blockId [solid|all|hollow]');
        return true;
    }

    applyHudVisibility() {
        const hudVisible = !this.hudHidden;
        const survivalHudVisible = hudVisible && !!this.survivalMode;

        if (this._healthBarEl) this._healthBarEl.style.display = survivalHudVisible ? 'block' : 'none';
        if (this._apBarEl) this._apBarEl.style.display = survivalHudVisible ? 'block' : 'none';
        if (this._mpBarEl) this._mpBarEl.style.display = survivalHudVisible ? 'block' : 'none';
        if (this._xpBarEl) this._xpBarEl.style.display = survivalHudVisible ? 'block' : 'none';
        if (this._goldDisplayEl) this._goldDisplayEl.style.display = survivalHudVisible ? 'block' : 'none';

        if (this.chatLogEl) this.chatLogEl.style.visibility = hudVisible ? 'visible' : 'hidden';
        if (this._minimapEl) this._minimapEl.style.visibility = hudVisible ? 'visible' : 'hidden';

        const crosshair = document.getElementById('crosshair');
        if (crosshair) crosshair.style.visibility = hudVisible ? 'visible' : 'hidden';

        const hotbarSlots = document.querySelectorAll('.hotbar-slot');
        if (hotbarSlots && hotbarSlots.length > 0) {
            hotbarSlots.forEach((slot) => {
                slot.style.visibility = hudVisible ? 'visible' : 'hidden';
            });
        }
    }

    runHudCommand(rawArg) {
        const arg = (rawArg || '').trim().toLowerCase();
        let nextVisible;

        if (arg === 'on' || arg === 'show' || arg === '1') {
            nextVisible = true;
        } else if (arg === 'off' || arg === 'hide' || arg === '0') {
            nextVisible = false;
        } else {
            nextVisible = this.hudHidden;
        }

        this.hudHidden = !nextVisible;
        this.applyHudVisibility();
        this.addChatMessage(`[System] HUD ${nextVisible ? 'visible' : 'hidden'}.`);
        return true;
    }

    handleChatCommand(text) {
        const wayMatch = text.match(/^[\/`]?way(?:\s+(.*))?$/i);
        if (wayMatch) {
            const label = wayMatch[1] || '';
            this.addMapWaypoint(label);
            return true;
        }

        const rtpMatch = text.match(/^[\/`]?rtp$/i);
        if (rtpMatch) {
            this.randomTeleportPlayer();
            return true;
        }

        const cmMatch = text.match(/^[\/`]?cm(?:\s+(on|off|creative|survival))?$/i);
        if (cmMatch) {
            const arg = (cmMatch[1] || '').toLowerCase();
            if (arg === 'on' || arg === 'creative') {
                this.setGameModeFromChatCommand(false);
            } else if (arg === 'off' || arg === 'survival') {
                this.setGameModeFromChatCommand(true);
            } else {
                this.setGameModeFromChatCommand(!this.survivalMode);
            }
            return true;
        }

        const npcHomeMatch = text.match(/^[\/`]?npch$/i);
        if (npcHomeMatch) {
            if (this.testSalesmen && this.player) {
                const px = this.player.position.x;
                const py = this.player.position.y;
                const pz = this.player.position.z;
                this.testSalesmen.homeAnchor = {
                    x: Math.floor(px), y: Math.floor(py), z: Math.floor(pz),
                    centerX: px, centerY: py, centerZ: pz
                };
                this.testSalesmen.homeForcedByCommand = true;
                if (this.testSalesmen.mesh) {
                    this.testSalesmen.mesh.position.set(px, py, pz);
                }
                this.addChatMessage('[NPC] Home force-assigned and NPC teleported to your position.');
            } else {
                this.addChatMessage('[NPC] No TestSalesmen NPC found in this world.');
            }
            return true;
        }

        const fillMatch = text.match(/^[\/`]?fill(?:\s+(.*))?$/i);
        if (fillMatch) {
            return this.runFillCommand(fillMatch[1] || '');
        }

        const bhelpMatch = text.match(/^[\/`]?bhelp$/i);
        if (bhelpMatch) {
            return this.runBlockHelpCommand();
        }

        const hudMatch = text.match(/^[\/`]?hud(?:\s+(.*))?$/i);
        if (hudMatch) {
            return this.runHudCommand(hudMatch[1] || '');
        }

        return false;
    }

    addChatMessage(msg) {
        if (!this.chatLogEl) return;
        const line = document.createElement('div');
        line.textContent = msg;
        this.chatLogEl.appendChild(line);
        this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    }

    createHealthBar() {
        if (this._healthBarEl) return;

        const container = document.createElement('div');
        container.id = 'health-bar-container';
        container.style.position = 'absolute';
        container.style.top = '20px';
        container.style.left = '20px';
        container.style.width = '200px';
        container.style.zIndex = '20';

        const label = document.createElement('div');
        label.textContent = 'Health';
        label.style.color = '#fff';
        label.style.fontFamily = 'Arial, sans-serif';
        label.style.fontSize = '14px';
        label.style.marginBottom = '4px';
        label.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
        container.appendChild(label);

        const barBg = document.createElement('div');
        barBg.style.width = '200px';
        barBg.style.height = '24px';
        barBg.style.background = 'rgba(0,0,0,0.5)';
        barBg.style.border = '2px solid #333';
        barBg.style.borderRadius = '4px';
        barBg.style.overflow = 'hidden';
        barBg.style.position = 'relative';

        const barFill = document.createElement('div');
        barFill.id = 'health-bar-fill';
        barFill.style.height = '100%';
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(to bottom, #ff4444, #cc0000)';
        barFill.style.transition = 'width 0.3s ease';
        barBg.appendChild(barFill);

        const barText = document.createElement('div');
        barText.id = 'health-bar-text';
        barText.textContent = '10/10';
        barText.style.position = 'absolute';
        barText.style.top = '50%';
        barText.style.left = '50%';
        barText.style.transform = 'translate(-50%, -50%)';
        barText.style.color = '#fff';
        barText.style.fontFamily = 'Arial, sans-serif';
        barText.style.fontSize = '12px';
        barText.style.fontWeight = 'bold';
        barText.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
        barBg.appendChild(barText);

        container.appendChild(barBg);
        document.body.appendChild(container);
        this._healthBarEl = container;
    }

    createAPBar() {
        if (this._apBarEl) return;

        const container = document.createElement('div');
        container.id = 'ap-bar-container';
        container.style.position = 'absolute';
        container.style.top = '74px';
        container.style.left = '20px';
        container.style.width = '200px';
        container.style.zIndex = '20';

        const label = document.createElement('div');
        label.textContent = 'AP';
        label.style.color = '#fff';
        label.style.fontFamily = 'Arial, sans-serif';
        label.style.fontSize = '14px';
        label.style.marginBottom = '4px';
        label.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
        container.appendChild(label);

        const barBg = document.createElement('div');
        barBg.style.width = '200px';
        barBg.style.height = '20px';
        barBg.style.background = 'rgba(0,0,0,0.5)';
        barBg.style.border = '2px solid #333';
        barBg.style.borderRadius = '4px';
        barBg.style.overflow = 'hidden';
        barBg.style.position = 'relative';

        const barFill = document.createElement('div');
        barFill.id = 'ap-bar-fill';
        barFill.style.height = '100%';
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(to bottom, #66d7ff, #0079c2)';
        barFill.style.transition = 'width 0.2s ease';
        barBg.appendChild(barFill);

        const barText = document.createElement('div');
        barText.id = 'ap-bar-text';
        barText.textContent = '5/5';
        barText.style.position = 'absolute';
        barText.style.top = '50%';
        barText.style.left = '50%';
        barText.style.transform = 'translate(-50%, -50%)';
        barText.style.color = '#fff';
        barText.style.fontFamily = 'Arial, sans-serif';
        barText.style.fontSize = '11px';
        barText.style.fontWeight = 'bold';
        barText.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
        barBg.appendChild(barText);

        container.appendChild(barBg);
        document.body.appendChild(container);
        this._apBarEl = container;
    }

    createMPBar() {
        if (this._mpBarEl) return;

        const container = document.createElement('div');
        container.id = 'mp-bar-container';
        container.style.position = 'absolute';
        container.style.top = '120px';
        container.style.left = '20px';
        container.style.width = '200px';
        container.style.zIndex = '20';

        const label = document.createElement('div');
        label.textContent = 'MP';
        label.style.color = '#fff';
        label.style.fontFamily = 'Arial, sans-serif';
        label.style.fontSize = '14px';
        label.style.marginBottom = '4px';
        label.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
        container.appendChild(label);

        const barBg = document.createElement('div');
        barBg.style.width = '200px';
        barBg.style.height = '20px';
        barBg.style.background = 'rgba(0,0,0,0.5)';
        barBg.style.border = '2px solid #333';
        barBg.style.borderRadius = '4px';
        barBg.style.overflow = 'hidden';
        barBg.style.position = 'relative';

        const barFill = document.createElement('div');
        barFill.id = 'mp-bar-fill';
        barFill.style.height = '100%';
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(to bottom, #8f6bff, #4d24b8)';
        barFill.style.transition = 'width 0.2s ease';
        barBg.appendChild(barFill);

        const barText = document.createElement('div');
        barText.id = 'mp-bar-text';
        barText.textContent = '3/30';
        barText.style.position = 'absolute';
        barText.style.top = '50%';
        barText.style.left = '50%';
        barText.style.transform = 'translate(-50%, -50%)';
        barText.style.color = '#fff';
        barText.style.fontFamily = 'Arial, sans-serif';
        barText.style.fontSize = '11px';
        barText.style.fontWeight = 'bold';
        barText.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
        barBg.appendChild(barText);

        container.appendChild(barBg);
        document.body.appendChild(container);
        this._mpBarEl = container;
    }

    createXPBar() {
        if (this._xpBarEl) return;

        const container = document.createElement('div');
        container.id = 'xp-bar-container';
        container.style.position = 'absolute';
        container.style.top = '166px';
        container.style.left = '20px';
        container.style.width = '200px';
        container.style.zIndex = '20';

        const label = document.createElement('div');
        label.id = 'xp-bar-label';
        label.textContent = 'XP Lv 1';
        label.style.color = '#fff';
        label.style.fontFamily = 'Arial, sans-serif';
        label.style.fontSize = '14px';
        label.style.marginBottom = '4px';
        label.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
        container.appendChild(label);

        const barBg = document.createElement('div');
        barBg.style.width = '200px';
        barBg.style.height = '16px';
        barBg.style.background = 'rgba(0,0,0,0.5)';
        barBg.style.border = '2px solid #333';
        barBg.style.borderRadius = '4px';
        barBg.style.overflow = 'hidden';
        barBg.style.position = 'relative';

        const barFill = document.createElement('div');
        barFill.id = 'xp-bar-fill';
        barFill.style.height = '100%';
        barFill.style.width = '0%';
        barFill.style.background = 'linear-gradient(to bottom, #b87bff, #6a29c7)';
        barFill.style.transition = 'width 0.2s ease';
        barBg.appendChild(barFill);

        const barText = document.createElement('div');
        barText.id = 'xp-bar-text';
        barText.textContent = '0/100';
        barText.style.position = 'absolute';
        barText.style.top = '50%';
        barText.style.left = '50%';
        barText.style.transform = 'translate(-50%, -50%)';
        barText.style.color = '#fff';
        barText.style.fontFamily = 'Arial, sans-serif';
        barText.style.fontSize = '10px';
        barText.style.fontWeight = 'bold';
        barText.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
        barBg.appendChild(barText);

        container.appendChild(barBg);
        document.body.appendChild(container);
        this._xpBarEl = container;
    }

    createGoldDisplay() {
        if (this._goldDisplayEl) return;

        const container = document.createElement('div');
        container.id = 'gold-display-container';
        container.style.position = 'absolute';
        container.style.top = '232px';
        container.style.left = '20px';
        container.style.width = '200px';
        container.style.zIndex = '20';
        container.style.background = 'rgba(0,0,0,0.5)';
        container.style.border = '2px solid #5a4712';
        container.style.borderRadius = '4px';
        container.style.padding = '6px 10px';
        container.style.boxSizing = 'border-box';

        const label = document.createElement('div');
        label.textContent = 'Gold';
        label.style.color = '#ffd54f';
        label.style.fontFamily = 'Arial, sans-serif';
        label.style.fontSize = '14px';
        label.style.marginBottom = '2px';
        label.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
        container.appendChild(label);

        const value = document.createElement('div');
        value.id = 'gold-display-text';
        value.textContent = '0';
        value.style.color = '#fff0b3';
        value.style.fontFamily = 'Arial, sans-serif';
        value.style.fontSize = '16px';
        value.style.fontWeight = 'bold';
        value.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
        container.appendChild(value);

        document.body.appendChild(container);
        this._goldDisplayEl = container;
    }

    updateHealthBar() {
        if (!this._healthBarEl || !this.player.survivalMode) return;

        const fill = document.getElementById('health-bar-fill');
        const text = document.getElementById('health-bar-text');
        
        if (fill && text) {
            const percent = (this.player.health / this.player.maxHealth) * 100;
            fill.style.width = percent + '%';
            text.textContent = `${this.player.health}/${this.player.maxHealth}`;
            
            // Change color based on health
            if (percent > 50) {
                fill.style.background = 'linear-gradient(to bottom, #ff4444, #cc0000)';
            } else if (percent > 25) {
                fill.style.background = 'linear-gradient(to bottom, #ff8844, #dd4400)';
            } else {
                fill.style.background = 'linear-gradient(to bottom, #ff0000, #880000)';
            }
        }
    }

    updateAPBar() {
        if (!this._apBarEl || !this.player || !this.player.survivalMode) return;

        const fill = document.getElementById('ap-bar-fill');
        const text = document.getElementById('ap-bar-text');

        if (fill && text) {
            const maxAp = Math.max(5, Number(this.player.maxAP) || 5);
            const ap = Math.max(0, Math.min(maxAp, Number(this.player.ap) || 0));
            this.player.maxAP = maxAp;
            this.player.ap = ap;
            const percent = (ap / maxAp) * 100;
            fill.style.width = percent + '%';
            text.textContent = `${Math.round(ap)}/${Math.round(maxAp)}`;
        }
    }

    updateMPBar() {
        if (!this._mpBarEl || !this.player || !this.player.survivalMode) return;

        const fill = document.getElementById('mp-bar-fill');
        const text = document.getElementById('mp-bar-text');

        if (fill && text) {
            const maxMp = Math.max(3, Math.min(30, Number(this.player.maxMP) || 3));
            const mp = Math.max(0, Math.min(maxMp, Number(this.player.mp) || 0));
            this.player.maxMP = maxMp;
            this.player.mp = mp;
            const percent = (mp / maxMp) * 100;
            fill.style.width = percent + '%';
            text.textContent = `${Math.round(mp)}/${Math.round(maxMp)}`;
        }
    }

    updateXPBar() {
        if (!this._xpBarEl || !this.player || !this.player.survivalMode) return;

        const fill = document.getElementById('xp-bar-fill');
        const text = document.getElementById('xp-bar-text');
        const label = document.getElementById('xp-bar-label');

        if (fill && text && label) {
            const maxLevel = Math.max(1, Number(this.player.maxLevel) || 27);
            const level = Math.max(1, Math.min(maxLevel, Number(this.player.level) || 1));
            const xpToNext = Math.max(1, Number(this.player.xpToNext) || 100);

            this.player.maxLevel = maxLevel;
            this.player.level = level;
            this.player.xpToNext = xpToNext;

            if (level >= maxLevel) {
                this.player.xp = 0;
                fill.style.width = '100%';
                text.textContent = 'MAX';
                label.textContent = `XP Lv ${level} (MAX)`;
                return;
            }

            const xp = Math.max(0, Math.min(xpToNext, Number(this.player.xp) || 0));
            this.player.xp = xp;
            const percent = (xp / xpToNext) * 100;
            fill.style.width = percent + '%';
            text.textContent = `${xp}/${xpToNext}`;
            label.textContent = `XP Lv ${level}`;
        }
    }

    updateGoldDisplay() {
        if (!this._goldDisplayEl || !this.player || !this.player.survivalMode) return;

        const text = document.getElementById('gold-display-text');
        if (text) {
            const gold = Math.max(0, Math.trunc(Number(this.player.gold) || 0));
            this.player.gold = gold;
            text.textContent = `${gold}`;
        }
    }

    openChest(cx, cy, cz) {
        const chestKey = `${cx},${cy},${cz}`;

        const lockData = this.lockedChests ? this.lockedChests.get(chestKey) : null;
        if (lockData && Number(lockData.keyLevel) === 1) {
            if (!this.hasLevelKey(1)) {
                console.log('This chest is locked. Requires Lv 1 Key.');
                return;
            }
            if (!this.consumeLevelKey(1)) {
                console.log('Failed to consume Lv 1 Key. Chest remains locked.');
                return;
            }
            console.log('Unlocked chest with Lv 1 Key (consumed).');
            this.lockedChests.delete(chestKey);
        }
        
        // Initialize chest storage if not exists
        if (!this.chestStorage.has(chestKey)) {
            const chestInv = new Array(20).fill(0);
            
            // Add special loot to room chest (in maze at y=20)
            if (cy === 20 && cx >= -12 && cx <= 11 && cz >= -12 && cz <= 11) {
                chestInv[0] = { type: 27, amount: 1 }; // Mana Orb
                chestInv[1] = { type: 27, amount: 1 }; // Mana Orb (2 total)
            }

            // Locked cathedral chest: guaranteed Agility Cape.
            if (this.cathedralLockedChestKey && chestKey === this.cathedralLockedChestKey) {
                chestInv[0] = { type: this.AGILITY_CAPE_TYPE, amount: 1, maxStack: 1 };
            }
            
            this.chestStorage.set(chestKey, chestInv);
        }

        this.createInventoryUI();
        if (this._inventoryEl) this._inventoryEl.style.display = 'block';
        this.openChestPos = chestKey;
        try { document.exitPointerLock(); } catch (e) {}
        this.createChestUI(cx, cy, cz);
    }

    opencandle(cx, cy, cz) {
        const key = `${cx},${cy},${cz}`;
        if (!this.candleStorage.has(key)) {
            // 3 slots: armor/tools, scrolls, result
            this.candleStorage.set(key, new Array(3).fill(0));
        }
        this.createInventoryUI();
        if (this._inventoryEl) this._inventoryEl.style.display = 'block';
        this.opencandlePos = key;
        try { document.exitPointerLock(); } catch (e) {}
        this.createcandleUI(cx, cy, cz);
    }

    // ─── Structure Block / In-game Structure Editor ───────────────────────────

    onStructureBlockPlaced(x, y, z) {
        if (!this.structureCorner1) {
            this.structureCorner1 = { x, y, z };
            this.showStructureMessage(`Corner 1 set at (${x}, ${y}, ${z}). Place a second Structure Block for corner 2.`);
        } else if (!this.structureCorner2) {
            this.structureCorner2 = { x, y, z };
            this.showStructureMessage('Both corners set! Opening save dialog…');
            this.openStructureSaveUI();
        } else {
            // Both already set — reset corners and start over
            this.structureCorner1 = { x, y, z };
            this.structureCorner2 = null;
            this.showStructureMessage(`Corners reset. Corner 1 set at (${x}, ${y}, ${z}). Place a second Structure Block for corner 2.`);
        }
    }

    showStructureMessage(msg) {
        let el = document.getElementById('structure-msg');
        if (!el) {
            el = document.createElement('div');
            el.id = 'structure-msg';
            el.style.position = 'fixed';
            el.style.top = '12%';
            el.style.left = '50%';
            el.style.transform = 'translateX(-50%)';
            el.style.background = 'rgba(60,0,120,0.9)';
            el.style.color = '#fff';
            el.style.padding = '10px 22px';
            el.style.borderRadius = '6px';
            el.style.fontSize = '14px';
            el.style.border = '1px solid #aa00ff';
            el.style.zIndex = '5000';
            el.style.pointerEvents = 'none';
            el.style.textAlign = 'center';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(el._hideTimeout);
        el._hideTimeout = setTimeout(() => { el.style.display = 'none'; }, 5000);
    }

    openStructureSaveUI() {
        const existing = document.getElementById('structure-save-ui');
        if (existing) existing.remove();

        if (!this.structureCorner1 || !this.structureCorner2) {
            this.showStructureMessage('Place two Structure Blocks to define the bounding box first.');
            return;
        }

        const c1 = this.structureCorner1, c2 = this.structureCorner2;
        const minX = Math.min(c1.x, c2.x), maxX = Math.max(c1.x, c2.x);
        const minY = Math.min(c1.y, c2.y), maxY = Math.max(c1.y, c2.y);
        const minZ = Math.min(c1.z, c2.z), maxZ = Math.max(c1.z, c2.z);
        const sX = maxX - minX + 1, sY = maxY - minY + 1, sZ = maxZ - minZ + 1;

        try { document.exitPointerLock(); } catch (e) {}

        const ui = document.createElement('div');
        ui.id = 'structure-save-ui';
        ui.style.cssText = `
            position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:#1a0033;color:#fff;padding:26px 30px;
            border:2px solid #aa00ff;border-radius:10px;
            z-index:9999;font-family:Arial,sans-serif;min-width:360px;
            box-shadow:0 0 28px #aa00ff88;
        `;
        ui.innerHTML = `
            <h2 style="margin:0 0 12px;color:#cc88ff;font-size:18px;">💾 Save Structure</h2>
            <p style="margin:0 0 10px;font-size:13px;color:#ccc;">
                Bounding box: (${minX},${minY},${minZ}) → (${maxX},${maxY},${maxZ})<br>
                Size: ${sX} × ${sY} × ${sZ} blocks
            </p>
            <label style="display:block;margin-bottom:4px;font-size:13px;">Structure name (used as JS key &amp; filename):</label>
            <input id="struct-name-input" type="text" value="my_structure"
                style="width:100%;padding:7px 10px;border-radius:4px;border:1px solid #aa00ff;
                       background:#2a0044;color:#fff;font-size:14px;box-sizing:border-box;margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;font-size:13px;">Anchor point (world coords subtracted from every op coord):</label>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;">
                <div>
                    <div style="font-size:11px;margin-bottom:3px;">anchorX</div>
                    <input id="struct-ax" type="number" value="${minX}"
                        style="width:100%;padding:5px;border-radius:4px;border:1px solid #666;background:#2a0044;color:#fff;box-sizing:border-box;font-size:13px;">
                </div>
                <div>
                    <div style="font-size:11px;margin-bottom:3px;">anchorY</div>
                    <input id="struct-ay" type="number" value="${minY}"
                        style="width:100%;padding:5px;border-radius:4px;border:1px solid #666;background:#2a0044;color:#fff;box-sizing:border-box;font-size:13px;">
                </div>
                <div>
                    <div style="font-size:11px;margin-bottom:3px;">anchorZ</div>
                    <input id="struct-az" type="number" value="${minZ}"
                        style="width:100%;padding:5px;border-radius:4px;border:1px solid #666;background:#2a0044;color:#fff;box-sizing:border-box;font-size:13px;">
                </div>
            </div>
            <div style="display:flex;gap:10px;">
                <button id="struct-save-btn"
                    style="flex:1;padding:11px;background:#7700cc;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;">
                    ⬇ Download JS
                </button>
                <button id="struct-cancel-btn"
                    style="flex:0 0 auto;padding:11px 18px;background:#333;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">
                    Cancel
                </button>
            </div>
        `;
        document.body.appendChild(ui);

        document.getElementById('struct-save-btn').addEventListener('click', () => {
            const rawName = document.getElementById('struct-name-input').value || 'my_structure';
            const name = rawName.replace(/[^a-zA-Z0-9_]/g, '_');
            const ax = parseInt(document.getElementById('struct-ax').value) || 0;
            const ay = parseInt(document.getElementById('struct-ay').value) || 0;
            const az = parseInt(document.getElementById('struct-az').value) || 0;
            this.exportStructureToJS(name, ax, ay, az);
            ui.remove();
            // Remove structure block markers from the world
            if (this.structureCorner1) this.world.setBlock(this.structureCorner1.x, this.structureCorner1.y, this.structureCorner1.z, 0);
            if (this.structureCorner2) this.world.setBlock(this.structureCorner2.x, this.structureCorner2.y, this.structureCorner2.z, 0);
            this.structureCorner1 = null;
            this.structureCorner2 = null;
        });

        document.getElementById('struct-cancel-btn').addEventListener('click', () => {
            ui.remove();
            // Remove structure block markers
            if (this.structureCorner1) this.world.setBlock(this.structureCorner1.x, this.structureCorner1.y, this.structureCorner1.z, 0);
            if (this.structureCorner2) this.world.setBlock(this.structureCorner2.x, this.structureCorner2.y, this.structureCorner2.z, 0);
            this.structureCorner1 = null;
            this.structureCorner2 = null;
        });
    }

    exportStructureToJS(structName, anchorX, anchorY, anchorZ) {
        const c1 = this.structureCorner1, c2 = this.structureCorner2;
        if (!c1 || !c2) return;

        const minX = Math.min(c1.x, c2.x), maxX = Math.max(c1.x, c2.x);
        const minY = Math.min(c1.y, c2.y), maxY = Math.max(c1.y, c2.y);
        const minZ = Math.min(c1.z, c2.z), maxZ = Math.max(c1.z, c2.z);

        // Collect non-air blocks, using greedy X-runs to generate fill ops where possible.
        // Structure block markers and connector markers are excluded from this pass.
        const ops = [];
        for (let wy = minY; wy <= maxY; wy++) {
            for (let wz = minZ; wz <= maxZ; wz++) {
                let runStart = -1, runBlock = -1;
                for (let wx = minX; wx <= maxX + 1; wx++) {
                    const raw = wx <= maxX ? this.world.getBlock(wx, wy, wz) : -1;
                    const b = (raw > 0 && raw !== this.STRUCTURE_BLOCK_TYPE && raw !== this.CONNECTER_BLOCK_TYPE) ? raw : 0;
                    if (b > 0 && b === runBlock) {
                        // extend current run
                    } else {
                        if (runStart !== -1 && runBlock > 0) {
                            const rx1 = runStart - anchorX, ry = wy - anchorY, rz = wz - anchorZ;
                            const rx2 = (wx - 1) - anchorX;
                            if (rx1 === rx2) {
                                ops.push(`        ["block", ${rx1}, ${ry}, ${rz}, ${runBlock}]`);
                            } else {
                                ops.push(`        ["fill",  ${rx1}, ${ry}, ${rz},  ${rx2}, ${ry}, ${rz},  ${runBlock}]`);
                            }
                        }
                        runStart = wx;
                        runBlock = b;
                    }
                }
            }
        }

        // Export connector blocks as explicit connecter ops so code/direction/letter persist.
        for (let wy = minY; wy <= maxY; wy++) {
            for (let wz = minZ; wz <= maxZ; wz++) {
                for (let wx = minX; wx <= maxX; wx++) {
                    const raw = this.world.getBlock(wx, wy, wz);
                    if (raw !== this.CONNECTER_BLOCK_TYPE) continue;

                    const rx = wx - anchorX;
                    const ry = wy - anchorY;
                    const rz = wz - anchorZ;
                    const data = this.normalizeConnectorData(this.getConnectorData(wx, wy, wz) || this.pendingConnectorData || { code: 1, dir: 'n', letter: 'a' });
                    ops.push(`        ["connecter", ${rx}, ${ry}, ${rz}, ${data.code}, "${data.dir}", "${data.letter}"]`);
                }
            }
        }

        const js =
`// Structure: ${structName}
// Generated by Agmora in-game structure editor
// Bounding box: (${minX},${minY},${minZ}) → (${maxX},${maxY},${maxZ})
// Anchor: (${anchorX}, ${anchorY}, ${anchorZ})
//
// Block IDs: 0=Air 1=Dirt 2=Grass 3=Stone 4=Sand 5=Water 6=Wood 7=Bricks
//   8=Ruby 9=Clay 10=Snow 11=Leafs 12=Sapphire 13=Plank 24=Coal
//   25=Torch 26=Chest 29=Magic Candle 33=Grim Stone 34=Lava 40=TNT 42=Cauldron
//
// Op formats:
//   ["fill",  x1, y1, z1,  x2, y2, z2,  blockId]  — fill rectangular region
//   ["block", x,  y,  z,   blockId]                — place a single block
//   ["connecter", x, y, z, blockId(1-99), direction, letter] — connector socket data
// Coords are relative to anchorX/Y/Z.

window.STRUCTURES.${structName} = {
    dimension: 'default',  // change to: 'astral', 'fairia', 'islands', etc.
    anchorX: ${anchorX},
    anchorY: ${anchorY},
    anchorZ: ${anchorZ},

    ops: [
${ops.join(',\n')}
    ]
};
`;
        const blob = new Blob([js], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${structName}.js`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.showStructureMessage(`"${structName}.js" downloaded! Put it in structures/ and add <script src="structures/${structName}.js"></script> in index.html.`);
    }

    opencauldron(cx, cy, cz) {
        const key = `${cx},${cy},${cz}`;
        if (!this.cauldronStorage.has(key)) {
            // 3 slots: ingredient, catalyst, result
            this.cauldronStorage.set(key, new Array(3).fill(0));
        }
        this.createInventoryUI();
        if (this._inventoryEl) this._inventoryEl.style.display = 'block';
        this.openCauldronPos = key;
        try { document.exitPointerLock(); } catch (e) {}
        this.createcauldronUI(cx, cy, cz);
    }

    getConnectorDataKey(x, y, z) {
        return `${x},${y},${z}`;
    }

    normalizeConnectorData(data) {
        const rawCode = Number(data && data.code);
        const code = Number.isFinite(rawCode) ? Math.max(1, Math.min(99, Math.floor(rawCode))) : 1;

        let dir = (data && typeof data.dir === 'string') ? data.dir.toLowerCase() : 'n';
        if (!['n', 'w', 'e', 's'].includes(dir)) dir = 'n';

        let letter = (data && typeof data.letter === 'string') ? data.letter.toLowerCase().trim() : 'a';
        if (!/^[a-z]$/.test(letter)) letter = 'a';

        return { code, dir, letter };
    }

    getConnectorData(x, y, z) {
        return this.connectorData.get(this.getConnectorDataKey(x, y, z)) || null;
    }

    setConnectorData(x, y, z, data) {
        const normalized = this.normalizeConnectorData(data || {});
        this.connectorData.set(this.getConnectorDataKey(x, y, z), normalized);
        return normalized;
    }

    openConnectorDataUI(x = null, y = null, z = null) {
        const existing = document.getElementById('connector-data-ui');
        if (existing) existing.remove();

        const editingPlaced = (x !== null && y !== null && z !== null);
        const existingData = editingPlaced ? this.getConnectorData(x, y, z) : null;
        const defaults = this.normalizeConnectorData(existingData || this.pendingConnectorData || { code: 1, dir: 'n', letter: 'a' });

        try { document.exitPointerLock(); } catch (e) {}

        const ui = document.createElement('div');
        ui.id = 'connector-data-ui';
        ui.style.cssText = `
            position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:#101524;color:#fff;padding:22px 24px;
            border:2px solid #4f8cff;border-radius:10px;
            z-index:9999;font-family:Arial,sans-serif;min-width:320px;
            box-shadow:0 0 24px #4f8cff66;
        `;

        const title = editingPlaced ? 'Edit Connector Data' : 'Set Connector Data';
        const subtitle = editingPlaced
            ? `Block at (${x}, ${y}, ${z})`
            : 'This will be used when you place connector blocks.';

        ui.innerHTML = `
            <h2 style="margin:0 0 10px;color:#9fc2ff;font-size:18px;">${title}</h2>
            <p style="margin:0 0 12px;font-size:12px;color:#c9d6ee;">${subtitle}</p>

            <label style="display:block;margin-bottom:4px;font-size:13px;">Code (1-99)</label>
            <input id="connector-code-input" type="number" min="1" max="99" value="${defaults.code}"
                style="width:100%;padding:7px 9px;border-radius:4px;border:1px solid #5b6e94;background:#1a2439;color:#fff;box-sizing:border-box;margin-bottom:10px;">

            <label style="display:block;margin-bottom:4px;font-size:13px;">Direction</label>
            <select id="connector-dir-input"
                style="width:100%;padding:7px 9px;border-radius:4px;border:1px solid #5b6e94;background:#1a2439;color:#fff;box-sizing:border-box;margin-bottom:10px;">
                <option value="n" ${defaults.dir === 'n' ? 'selected' : ''}>n</option>
                <option value="w" ${defaults.dir === 'w' ? 'selected' : ''}>w</option>
                <option value="e" ${defaults.dir === 'e' ? 'selected' : ''}>e</option>
                <option value="s" ${defaults.dir === 's' ? 'selected' : ''}>s</option>
            </select>

            <label style="display:block;margin-bottom:4px;font-size:13px;">Letter (a-z)</label>
            <input id="connector-letter-input" type="text" maxlength="1" value="${defaults.letter}"
                style="width:100%;padding:7px 9px;border-radius:4px;border:1px solid #5b6e94;background:#1a2439;color:#fff;box-sizing:border-box;margin-bottom:14px;text-transform:lowercase;">

            <div style="display:flex;gap:10px;">
                <button id="connector-save-btn"
                    style="flex:1;padding:10px;background:#2f76ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;">
                    Save
                </button>
                <button id="connector-cancel-btn"
                    style="flex:0 0 auto;padding:10px 16px;background:#3a3a3a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">
                    Cancel
                </button>
            </div>
        `;

        document.body.appendChild(ui);

        const closeAndRelock = () => {
            ui.remove();
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
            } catch (e) {}
        };

        document.getElementById('connector-save-btn').addEventListener('click', () => {
            const code = parseInt(document.getElementById('connector-code-input').value, 10);
            const dir = document.getElementById('connector-dir-input').value;
            const letter = document.getElementById('connector-letter-input').value;
            const normalized = this.normalizeConnectorData({ code, dir, letter });

            this.pendingConnectorData = normalized;
            if (editingPlaced) {
                this.setConnectorData(x, y, z, normalized);
                this.showStructureMessage(`Connector updated: code ${normalized.code}, dir ${normalized.dir}, letter ${normalized.letter}`);
            } else {
                this.showStructureMessage(`Connector data ready: code ${normalized.code}, dir ${normalized.dir}, letter ${normalized.letter}`);
            }
            closeAndRelock();
        });

        document.getElementById('connector-cancel-btn').addEventListener('click', closeAndRelock);
    }

    createChestUI(cx, cy, cz) {
        const chestKey = `${cx},${cy},${cz}`;
        const chestInventory = this.chestStorage.get(chestKey);
        
        // Create or get chest container in inventory
        let chestWindow = document.getElementById('chest-ui');
        if (!chestWindow) {
            chestWindow = document.createElement('div');
            chestWindow.id = 'chest-ui';
            chestWindow.style.marginTop = '16px';
            chestWindow.style.padding = '12px';
            chestWindow.style.background = 'rgba(20, 20, 20, 0.8)';
            chestWindow.style.border = '2px solid #8B4513';
            chestWindow.style.borderRadius = '4px';
            chestWindow.style.fontFamily = 'Arial, sans-serif';
            chestWindow.style.color = '#FFFFFF';
            
            // Add to inventory if it exists
            const invEl = this._inventoryEl;
            if (invEl) invEl.appendChild(chestWindow);
        } else {
            // Clear existing chest slots
            chestWindow.innerHTML = '';
        }

        chestWindow.style.display = 'block';
        
        // Title
        const title = document.createElement('h2');
        title.textContent = 'Chest Storage';
        title.style.margin = '0 0 12px 0';
        title.style.fontSize = '16px';
        chestWindow.appendChild(title);
        
        // Chest slots grid (20 slots in 5x4)
        const slotsDiv = document.createElement('div');
        slotsDiv.style.display = 'grid';
        slotsDiv.style.gridTemplateColumns = 'repeat(5, 60px)';
        slotsDiv.style.gap = '8px';
        slotsDiv.style.marginBottom = '12px';
        
        for (let i = 0; i < 20; i++) {
            const slot = document.createElement('div');
            slot.className = 'chest-slot';
            slot.dataset.slotIndex = i;
            slot.style.width = '60px';
            slot.style.height = '60px';
            slot.style.background = '#4A3728';
            slot.style.border = '2px solid #654321';
            slot.style.borderRadius = '4px';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.cursor = 'move';
            slot.style.fontSize = '12px';
            slot.style.color = '#FFFFFF';
            slot.style.userSelect = 'none';
            
            // Set item text if slot has something
            if (chestInventory[i] && chestInventory[i] !== 0) {
                const item = chestInventory[i];
                const itemType = typeof item === 'object' ? item.type : item;
                const amount = typeof item === 'object' ? item.amount : 1;
                slot.textContent = this.blockNames[itemType] || 'Item';
                slot.title = amount > 1 ? `×${amount}` : '';
            }
            
            slot.draggable = true;
            slot.addEventListener('dragstart', (e) => this.chestDragStart(e, chestKey));
            slot.addEventListener('dragover', (e) => e.preventDefault());
            slot.addEventListener('drop', (e) => this.chestDrop(e, chestKey));
            
            // Click handler for gamepad support - select item from chest
            slot.addEventListener('click', (e) => {
                const slotIdx = Number(slot.dataset.slotIndex);
                const item = chestInventory[slotIdx];
                
                // If empty slot, do nothing
                if (!item || item === 0) return;
                
                // Try to add item to player inventory
                const itemType = typeof item === 'object' ? item.type : item;
                const amount = typeof item === 'object' ? item.amount : 1;
                
                let remaining = amount;
                
                // Try to stack with existing items
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    const invSlot = this.player.inventory[j];
                    if (invSlot && typeof invSlot === 'object' && invSlot.type === itemType && invSlot.amount < invSlot.maxStack) {
                        const canAdd = invSlot.maxStack - invSlot.amount;
                        const toAdd = Math.min(remaining, canAdd);
                        invSlot.amount += toAdd;
                        remaining -= toAdd;
                    } else if (typeof invSlot === 'number' && invSlot === itemType) {
                        // Legacy numeric format
                        const canAdd = 64 - 1; // Assume max 64
                        const toAdd = Math.min(remaining, canAdd);
                        this.player.inventory[j] = { type: itemType, amount: 1 + toAdd, maxStack: 64 };
                        remaining -= toAdd;
                    }
                }
                
                // Find empty slots
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    if (this.player.inventory[j] === 0) {
                        const toAdd = Math.min(remaining, 64);
                        this.player.inventory[j] = { type: itemType, amount: toAdd, maxStack: 64 };
                        remaining -= toAdd;
                    }
                }
                
                // Remove from chest
                if (remaining < amount) {
                    const toRemove = amount - remaining;
                    if (typeof item === 'object') {
                        item.amount -= toRemove;
                        if (item.amount <= 0) {
                            chestInventory[slotIdx] = 0;
                        }
                    } else {
                        chestInventory[slotIdx] = 0;
                    }
                    // Just update the slot display without rebuilding entire UI
                    slot.textContent = '';
                    slot.title = '';
                    const updatedItem = chestInventory[slotIdx];
                    if (updatedItem && updatedItem !== 0) {
                        const updatedType = typeof updatedItem === 'object' ? updatedItem.type : updatedItem;
                        const updatedAmount = typeof updatedItem === 'object' ? updatedItem.amount : 1;
                        slot.textContent = this.blockNames[updatedType] || 'Item';
                        slot.title = updatedAmount > 1 ? `×${updatedAmount}` : '';
                    }
                    this.updateInventoryUI();
                }
            });
            
            slotsDiv.appendChild(slot);
        }
        chestWindow.appendChild(slotsDiv);
        
        // Info text
        const info = document.createElement('p');
        info.style.margin = '0';
        info.style.fontSize = '12px';
        info.style.color = '#AAAAAA';
        info.textContent = 'Drag items to move between chest and inventory';
        chestWindow.appendChild(info);
        
        // Already added to inventory in createChestUI
        this.inventoryOpen = true;
    }

    getItemTypeValue(item) {
        if (!item) return 0;
        return typeof item === 'object' ? item.type : item;
    }

    isConsumableType(type) {
        return type === 17 || type === this.HEALING_POTION_TYPE || type === this.CHILLING_POTION_TYPE;
    }

    isArmorType(type) {
        return type === 18 || type === 19 || type === 20 || type === 21;
    }

    isSwordType(type) {
        return type === 22 || type === 32; // Stone Sword or Golden Sword
    }

    getItemNameWithBonus(item) {
        if (!item) return '';
        const type = this.getItemTypeValue(item);
        const base = this.blockNames[type] || 'Item';
        let bonus = '';
        if (item && typeof item === 'object') {
            if (item.armorBonus) bonus += ` +${item.armorBonus}% Armor`;
            if (item.damageBonus) bonus += ` +${item.damageBonus}% Damage`;
            if (item.jumpBonus) bonus += ` +${item.jumpBonus}% Jump`;
            if (item.doubleJump) bonus += ` [Double Jump]`;
            if (item.hasCurse && item.curseType === 'gloom') bonus += ` [Gloom Curse]`;
        }
        const amt = (item && typeof item === 'object' && item.amount > 1) ? ` x${item.amount}` : '';
        return base + bonus + amt;
    }

    tryProcesscandle(candleKey) {
        const inv = this.candleStorage.get(candleKey);
        if (!inv) return;

        const armorItem = inv[0];
        const scrollItem = inv[1];
        const resultItem = inv[2];

        // Only proceed if result slot is empty
        if (resultItem && resultItem !== 0) return;

        const armorType = this.getItemTypeValue(armorItem);
        const scrollType = this.getItemTypeValue(scrollItem);

        if (!this.isArmorType(armorType) && !this.isSwordType(armorType)) return;
        if (scrollType !== 28 && scrollType !== 35 && scrollType !== 36 && scrollType !== this.ASTARA_SCROLL_TYPE && scrollType !== this.CLOUTUMP_SCROLL_TYPE) return;
        
        // Check if Smiteth Scroll is for swords only
        if (scrollType === 35 && !this.isSwordType(armorType)) return;
        
        // Check if Gloom curse is for swords only
        if (scrollType === 36 && !this.isSwordType(armorType)) return;

        // Astara is leggings-only
        if (scrollType === this.ASTARA_SCROLL_TYPE && armorType !== 20) return;

        // Cloutump is boots-only
        if (scrollType === this.CLOUTUMP_SCROLL_TYPE && armorType !== 21) return;

        // Consume one scroll
        if (scrollItem && typeof scrollItem === 'object') {
            scrollItem.amount = (scrollItem.amount || 1) - 1;
            if (scrollItem.amount <= 0) {
                inv[1] = 0;
            }
        } else {
            inv[1] = 0;
        }

        // Consume the armor piece (no stacking expected)
        const baseArmor = (armorItem && typeof armorItem === 'object') ? armorItem : new Item(armorType, 1);
        inv[0] = 0;

        // Create enchanted item
        const enchanted = new Item(baseArmor.type, 1);
        enchanted.maxStack = 1;
        
        // 10% chance to receive Gloom curse as debuff
        const isCursed = Math.random() < 0.1;
        
        if (isCursed) {
            // Gloom curse: applies blindness on hit to wearer
            enchanted.hasCurse = true;
            enchanted.curseType = 'gloom';
        } else if (scrollType === 28) {
            // Fortitudo Scroll: +10% armor
            enchanted.armorBonus = (baseArmor.armorBonus || 0) + 10;
        } else if (scrollType === 35) {
            // Smiteth Scroll: +6% damage (sword only)
            enchanted.damageBonus = (baseArmor.damageBonus || 0) + 6;
        } else if (scrollType === this.ASTARA_SCROLL_TYPE) {
            // Astara Scroll: leggings gain +3% jump height.
            enchanted.jumpBonus = (baseArmor.jumpBonus || 0) + 3;
        } else if (scrollType === this.CLOUTUMP_SCROLL_TYPE) {
            // Cloutump Scroll: boots grant one extra jump while airborne.
            enchanted.doubleJump = true;
        }
        
        inv[2] = enchanted;

        // Refresh UI after processing
        this.refreshContainerUI(candleKey);
        this.updateInventoryUI();
    }

    createcandleUI(cx, cy, cz) {
        const candleKey = `${cx},${cy},${cz}`;
        const candleInv = this.candleStorage.get(candleKey);

        let candleWindow = document.getElementById('candle-ui');
        if (!candleWindow) {
            candleWindow = document.createElement('div');
            candleWindow.id = 'candle-ui';
            candleWindow.style.marginTop = '16px';
            candleWindow.style.padding = '12px';
            candleWindow.style.background = 'rgba(30, 40, 70, 0.8)';
            candleWindow.style.border = '2px solid #C0C0C0';
            candleWindow.style.borderRadius = '4px';
            candleWindow.style.fontFamily = 'Arial, sans-serif';
            candleWindow.style.color = '#E6F0FF';

            const invEl = this._inventoryEl;
            if (invEl) invEl.appendChild(candleWindow);
        } else {
            candleWindow.innerHTML = '';
        }

        candleWindow.style.display = 'block';

        const title = document.createElement('h3');
        title.textContent = 'Magic candle';
        title.style.margin = '0 0 8px 0';
        title.style.fontSize = '14px';
        candleWindow.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(3, 64px)';
        grid.style.gap = '8px';
        grid.style.marginBottom = '8px';

        const labels = ['Armor / Tools', 'Scrolls', 'Result'];

        for (let i = 0; i < 3; i++) {
            const cell = document.createElement('div');
            cell.style.display = 'flex';
            cell.style.flexDirection = 'column';
            cell.style.alignItems = 'center';

            const slot = document.createElement('div');
            slot.className = 'chest-slot'; // reuse chest drag/drop logic
            slot.dataset.slotIndex = i;
            slot.style.width = '64px';
            slot.style.height = '64px';
            slot.style.background = 'rgba(80,100,140,0.4)';
            slot.style.border = '2px solid #A0B8FF';
            slot.style.borderRadius = '6px';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.cursor = 'move';
            slot.style.fontSize = '12px';
            slot.style.color = '#FFFFFF';
            slot.style.userSelect = 'none';

            const item = candleInv ? candleInv[i] : 0;
            if (item && item !== 0) {
                const label = this.getItemNameWithBonus(item);
                slot.textContent = label;
                slot.title = label;
            }

            slot.draggable = true;
            slot.addEventListener('dragstart', (e) => this.chestDragStart(e, candleKey));
            slot.addEventListener('dragover', (e) => e.preventDefault());
            slot.addEventListener('drop', (e) => this.chestDrop(e, candleKey));
            
            // Click handler for gamepad support
            slot.addEventListener('click', (e) => {
                const slotIdx = Number(slot.dataset.slotIndex);
                // candle slot 2 is the result slot and can't be clicked to take
                if (slotIdx === 2) return;
                
                const item = candleInv ? candleInv[slotIdx] : 0;
                if (!item || item === 0) return;
                
                // Try to add to player inventory
                const itemType = typeof item === 'object' ? item.type : item;
                const amount = typeof item === 'object' ? item.amount : 1;
                
                let remaining = amount;
                
                // Try to stack
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    const invSlot = this.player.inventory[j];
                    if (invSlot && typeof invSlot === 'object' && invSlot.type === itemType && invSlot.amount < invSlot.maxStack) {
                        const canAdd = invSlot.maxStack - invSlot.amount;
                        const toAdd = Math.min(remaining, canAdd);
                        invSlot.amount += toAdd;
                        remaining -= toAdd;
                    }
                }
                
                // Find empty slots
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    if (this.player.inventory[j] === 0) {
                        const toAdd = Math.min(remaining, 64);
                        this.player.inventory[j] = { type: itemType, amount: toAdd, maxStack: 64 };
                        remaining -= toAdd;
                    }
                }
                
                // Remove from candle
                if (remaining < amount) {
                    const toRemove = amount - remaining;
                    if (typeof item === 'object') {
                        item.amount -= toRemove;
                        if (item.amount <= 0) {
                            candleInv[slotIdx] = 0;
                        }
                    } else {
                        candleInv[slotIdx] = 0;
                    }
                    // Just update the slot display without rebuilding entire UI
                    slot.textContent = '';
                    slot.title = '';
                    const updatedItem = candleInv ? candleInv[slotIdx] : 0;
                    if (updatedItem && updatedItem !== 0) {
                        const label = this.getItemNameWithBonus(updatedItem);
                        slot.textContent = label;
                        slot.title = label;
                    }
                    this.updateInventoryUI();
                }
            });

            const lbl = document.createElement('div');
            lbl.textContent = labels[i];
            lbl.style.marginTop = '6px';
            lbl.style.fontSize = '11px';
            lbl.style.color = '#C8D8FF';

            cell.appendChild(slot);
            cell.appendChild(lbl);
            grid.appendChild(cell);
        }

        candleWindow.appendChild(grid);

        const info = document.createElement('p');
        info.style.margin = '0';
        info.style.fontSize = '11px';
        info.style.color = '#A8B8D8';
        info.textContent = 'Drop items from inventory into the slots';
        candleWindow.appendChild(info);

        this.inventoryOpen = true;
    }

    tryProcesscauldron(cauldronKey) {
        const inv = this.cauldronStorage.get(cauldronKey);
        if (!inv) return;

        const ingredient = inv[0];
        const catalyst = inv[1];
        const resultItem = inv[2];
        if (resultItem && resultItem !== 0) return;

        const ingredientType = this.getItemTypeValue(ingredient);
        const catalystType = this.getItemTypeValue(catalyst);

        // Recipe 1: 1 Pork + 1 Paper -> 1 Healing Potion
        // Recipe 2: 1 Healing Potion + 1 Snow -> 1 Potion of Chilling
        let resultType = null;
        if (ingredientType === 17 && catalystType === 14) {
            resultType = this.HEALING_POTION_TYPE;
        } else if (ingredientType === this.HEALING_POTION_TYPE && catalystType === 10) {
            resultType = this.CHILLING_POTION_TYPE;
        } else {
            return;
        }

        if (ingredient && typeof ingredient === 'object') {
            ingredient.amount = (ingredient.amount || 1) - 1;
            if (ingredient.amount <= 0) inv[0] = 0;
        } else {
            inv[0] = 0;
        }

        if (catalyst && typeof catalyst === 'object') {
            catalyst.amount = (catalyst.amount || 1) - 1;
            if (catalyst.amount <= 0) inv[1] = 0;
        } else {
            inv[1] = 0;
        }

        inv[2] = { type: resultType, amount: 1, maxStack: 16 };
        this.refreshContainerUI(cauldronKey);
        this.updateInventoryUI();
    }

    createcauldronUI(cx, cy, cz) {
        const cauldronKey = `${cx},${cy},${cz}`;
        const cauldronInv = this.cauldronStorage.get(cauldronKey);

        let cauldronWindow = document.getElementById('cauldron-ui');
        if (!cauldronWindow) {
            cauldronWindow = document.createElement('div');
            cauldronWindow.id = 'cauldron-ui';
            cauldronWindow.style.marginTop = '16px';
            cauldronWindow.style.padding = '12px';
            cauldronWindow.style.background = 'rgba(60, 30, 20, 0.85)';
            cauldronWindow.style.border = '2px solid #9a6a3a';
            cauldronWindow.style.borderRadius = '4px';
            cauldronWindow.style.fontFamily = 'Arial, sans-serif';
            cauldronWindow.style.color = '#fff5e6';

            const invEl = this._inventoryEl;
            if (invEl) invEl.appendChild(cauldronWindow);
        } else {
            cauldronWindow.innerHTML = '';
        }

        cauldronWindow.style.display = 'block';

        const title = document.createElement('h3');
        title.textContent = 'Cauldron';
        title.style.margin = '0 0 8px 0';
        title.style.fontSize = '14px';
        cauldronWindow.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(3, 64px)';
        grid.style.gap = '8px';
        grid.style.marginBottom = '8px';

        const labels = ['Ingredient', 'Catalyst', 'Result'];
        for (let i = 0; i < 3; i++) {
            const cell = document.createElement('div');
            cell.style.display = 'flex';
            cell.style.flexDirection = 'column';
            cell.style.alignItems = 'center';

            const slot = document.createElement('div');
            slot.className = 'chest-slot';
            slot.dataset.slotIndex = i;
            slot.style.width = '64px';
            slot.style.height = '64px';
            slot.style.background = 'rgba(120,80,40,0.35)';
            slot.style.border = '2px solid #b38755';
            slot.style.borderRadius = '6px';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.cursor = 'move';
            slot.style.fontSize = '12px';
            slot.style.color = '#FFFFFF';
            slot.style.userSelect = 'none';

            const item = cauldronInv ? cauldronInv[i] : 0;
            if (item && item !== 0) {
                const label = this.getItemNameWithBonus(item);
                slot.textContent = label;
                slot.title = label;
            }

            slot.draggable = true;
            slot.addEventListener('dragstart', (e) => this.chestDragStart(e, cauldronKey));
            slot.addEventListener('dragover', (e) => e.preventDefault());
            slot.addEventListener('drop', (e) => this.chestDrop(e, cauldronKey));

            const lbl = document.createElement('div');
            lbl.textContent = labels[i];
            lbl.style.marginTop = '6px';
            lbl.style.fontSize = '11px';
            lbl.style.color = '#ffd8ad';

            cell.appendChild(slot);
            cell.appendChild(lbl);
            grid.appendChild(cell);
        }

        cauldronWindow.appendChild(grid);

        const info = document.createElement('p');
        info.style.margin = '0';
        info.style.fontSize = '11px';
        info.style.color = '#ffd8ad';
        info.textContent = 'Recipes: Pork + Paper → Healing Potion  |  Healing Potion + Snow → Potion of Chilling';
        cauldronWindow.appendChild(info);

        this.inventoryOpen = true;
    }

    closeChestUI() {
        const chestWindow = document.getElementById('chest-ui');
        if (chestWindow) chestWindow.style.display = 'none';
        this.openChestPos = null;
        if (!this.opencandlePos && !this.openCauldronPos) this.inventoryOpen = false;
    }

    closecandleUI() {
        const candleWindow = document.getElementById('candle-ui');
        if (candleWindow) candleWindow.style.display = 'none';
        this.opencandlePos = null;
        if (!this.openChestPos && !this.openCauldronPos) this.inventoryOpen = false;
    }

    closecauldronUI() {
        const cauldronWindow = document.getElementById('cauldron-ui');
        if (cauldronWindow) cauldronWindow.style.display = 'none';
        this.openCauldronPos = null;
        if (!this.openChestPos && !this.opencandlePos) this.inventoryOpen = false;
    }

    refreshContainerUI(storageKey) {
        const coords = storageKey.split(',').map(Number);
        if (this.chestStorage.has(storageKey)) {
            this.createChestUI(...coords);
        } else if (this.candleStorage.has(storageKey)) {
            this.createcandleUI(...coords);
        } else if (this.cauldronStorage.has(storageKey)) {
            this.createcauldronUI(...coords);
        }
    }

    chestDragStart(e, chestKey) {
        const slot = e.target;
        const slotIndex = parseInt(slot.dataset.slotIndex);
        const containerInventory = this.chestStorage.get(chestKey) || this.candleStorage.get(chestKey) || this.cauldronStorage.get(chestKey);
        if (!containerInventory) return;
        const item = containerInventory[slotIndex];
        
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('chestSource', JSON.stringify({
            chestKey, slotIndex, item
        }));
    }

    chestDrop(e, chestKey) {
        e.preventDefault();
        const slot = e.target.closest('.chest-slot');
        if (!slot) return;
        
        const dropSlotIndex = parseInt(slot.dataset.slotIndex);
        const sourceData = JSON.parse(e.dataTransfer.getData('chestSource') || '{}');
        const invIndex = Number(e.dataTransfer.getData('text/plain'));
        
        const destChest = this.chestStorage.get(chestKey) || this.candleStorage.get(chestKey) || this.cauldronStorage.get(chestKey);
        if (!destChest) return;

        // Case 1: dragging from another container
        if (sourceData.chestKey) {
            const sourceChest = this.chestStorage.get(sourceData.chestKey) || this.candleStorage.get(sourceData.chestKey) || this.cauldronStorage.get(sourceData.chestKey);
            if (sourceChest) {
                const temp = destChest[dropSlotIndex];
                destChest[dropSlotIndex] = sourceChest[sourceData.slotIndex];
                sourceChest[sourceData.slotIndex] = temp;

                if (this.candleStorage.has(chestKey)) this.tryProcesscandle(chestKey);
                if (this.candleStorage.has(sourceData.chestKey)) this.tryProcesscandle(sourceData.chestKey);
                if (this.cauldronStorage.has(chestKey)) this.tryProcesscauldron(chestKey);
                if (this.cauldronStorage.has(sourceData.chestKey)) this.tryProcesscauldron(sourceData.chestKey);

                this.refreshContainerUI(chestKey);
                if (sourceData.chestKey !== chestKey) {
                    this.refreshContainerUI(sourceData.chestKey);
                }
            }
            return;
        }

        // Case 2: dragging from inventory into container
        if (!Number.isNaN(invIndex)) {
            const invItem = this.player.inventory[invIndex];
            if (!invItem || invItem === 0) return;

            const temp = destChest[dropSlotIndex];
            destChest[dropSlotIndex] = invItem;
            
            this.player.inventory[invIndex] = temp || 0;

            if (this.candleStorage.has(chestKey)) this.tryProcesscandle(chestKey);
            if (this.cauldronStorage.has(chestKey)) this.tryProcesscauldron(chestKey);

            this.refreshContainerUI(chestKey);
            this.updateInventoryUI();
        }
    }

    respawnPlayerInOverworld() {
        const latestSaveKey = this.getLatestSaveKey();
        if (latestSaveKey && typeof window.loadSavedWorld === 'function') {
            window.loadSavedWorld(latestSaveKey);
            return;
        }

        console.log('No saved world found. Falling back to default respawn behavior.');

        // If the player died in a dimension, restore the saved overworld state first.
        const restoreState = this.inFairiaDimension ? this.fairiaReturnState
            : (this.inAstralDimension ? this.astralReturnState : null);

        if (restoreState) {
            this.clearChunkMeshes();
            this.clearTorchLights();

            this.world = restoreState.world;
            this.dayTime = restoreState.dayTime;
            this.chunkMeshes = new Map();
            this.chunkBounds = new Map();
            this.chunkMeshQueue = [];
            this.generatingChunkMesh = false;
            this.torchLights = new Map();
            this.chestStorage = restoreState.chestStorage || new Map();
            this.lockedChests = restoreState.lockedChests || new Map();
            this.cathedralLockedChestKey = restoreState.cathedralLockedChestKey || null;
            this.candleStorage = restoreState.candleStorage || new Map();
            this.cauldronStorage = restoreState.cauldronStorage || new Map();
            this.mesher = new BlockMesher(this.world, this.textureAtlas);
            if (this.itemManager) this.itemManager.world = this.world;

            this.inFairiaDimension = false;
            this.inAstralDimension = false;
            this.fairiaReturnState = null;
            this.astralReturnState = null;

            // Restore overworld music; day/night cycle can switch tracks afterward.
            if (this.gameMusic && this.world && this.world.worldType !== 'fairia') {
                this.gameMusic.pause();
                this.gameMusic.currentTime = 0;
                this.gameMusic.src = 'Posey.ogg';
                this._currentMusicTrack = 'Posey.ogg';
                setTimeout(() => {
                    this.gameMusic.play().catch(e => console.log('Respawn music play failed:', e));
                }, 100);
            }
        }

        this.player.health = this.player.maxHealth;
        this.player.ap = this.player.maxAP;
        this.player.isDead = false;
        this.player.position.copy(this.getSafeSpawnPositionNear(0, 0, 4));
        this.player.velocity.set(0, 0, 0);
        this.player.yaw = 0;
        this.player.pitch = 0;
        this.updateHealthBar();
        this.updateAPBar();
        this.generateInitialChunks();
    }

    showDeathScreen() {
        if (this._deathScreenShown) return;
        this._deathScreenShown = true;

        const screen = document.createElement('div');
        screen.style.position = 'absolute';
        screen.style.top = '0';
        screen.style.left = '0';
        screen.style.width = '100%';
        screen.style.height = '100%';
        screen.style.background = 'rgba(0,0,0,0.85)';
        screen.style.display = 'flex';
        screen.style.flexDirection = 'column';
        screen.style.alignItems = 'center';
        screen.style.justifyContent = 'center';
        screen.style.zIndex = '500';

        const title = document.createElement('h1');
        title.textContent = 'You Died!';
        title.style.color = '#ff0000';
        title.style.fontSize = '72px';
        title.style.fontFamily = 'Arial, sans-serif';
        title.style.textShadow = '4px 4px 8px rgba(0,0,0,0.8)';
        title.style.marginBottom = '40px';
        screen.appendChild(title);

        const respawnBtn = document.createElement('button');
        respawnBtn.textContent = 'Respawn';
        respawnBtn.style.padding = '16px 32px';
        respawnBtn.style.fontSize = '24px';
        respawnBtn.style.background = '#00aa00';
        respawnBtn.style.color = '#fff';
        respawnBtn.style.border = 'none';
        respawnBtn.style.borderRadius = '8px';
        respawnBtn.style.cursor = 'pointer';
        respawnBtn.style.marginRight = '16px';
        respawnBtn.addEventListener('click', () => {
            this.respawnPlayerInOverworld();
            document.body.removeChild(screen);
            this._deathScreenShown = false;
        });
        screen.appendChild(respawnBtn);

        const menuBtn = document.createElement('button');
        menuBtn.textContent = 'Main Menu';
        menuBtn.style.padding = '16px 32px';
        menuBtn.style.fontSize = '24px';
        menuBtn.style.background = '#cc0000';
        menuBtn.style.color = '#fff';
        menuBtn.style.border = 'none';
        menuBtn.style.borderRadius = '8px';
        menuBtn.style.cursor = 'pointer';
        menuBtn.addEventListener('click', () => {
            window.location.reload();
        });
        screen.appendChild(menuBtn);

        document.body.appendChild(screen);
    }

    getSaveSlotKey(slotIndex) {
        const slot = Math.max(1, Math.min(8, Math.round(Number(slotIndex) || 1)));
        return `voxelWorldSave${slot}`;
    }

    getLatestSaveKey() {
        let latestKey = null;
        let latestTimestamp = -1;

        for (let slot = 1; slot <= 8; slot++) {
            const key = this.getSaveSlotKey(slot);
            const legacyKey = slot === 1 ? 'voxelWorldSave' : null;
            const raw = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
            if (!raw) continue;

            try {
                const parsed = JSON.parse(raw);
                const ts = Number(parsed && parsed.timestamp) || 0;
                if (ts > latestTimestamp) {
                    latestTimestamp = ts;
                    latestKey = localStorage.getItem(key) ? key : legacyKey;
                }
            } catch {}
        }

        return latestKey;
    }

    getSaveSlotLabel(slotIndex) {
        const slot = Math.max(1, Math.min(8, Math.round(Number(slotIndex) || 1)));
        return `Slot ${slot}`;
    }

    showSaveSlotMenu(onSelect) {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.left = '0';
        overlay.style.top = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.background = 'rgba(0,0,0,0.55)';
        overlay.style.zIndex = '1100';

        const panel = document.createElement('div');
        panel.style.position = 'absolute';
        panel.style.left = '50%';
        panel.style.top = '50%';
        panel.style.transform = 'translate(-50%, -50%)';
        panel.style.background = 'rgba(15,15,15,0.96)';
        panel.style.border = '2px solid #666';
        panel.style.borderRadius = '10px';
        panel.style.padding = '18px';
        panel.style.minWidth = '320px';
        panel.style.color = '#fff';
        overlay.appendChild(panel);

        const title = document.createElement('div');
        title.textContent = 'Choose Save Slot';
        title.style.fontSize = '22px';
        title.style.fontWeight = 'bold';
        title.style.textAlign = 'center';
        title.style.marginBottom = '14px';
        panel.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        grid.style.gap = '10px';
        panel.appendChild(grid);

        for (let slot = 1; slot <= 8; slot++) {
            const key = this.getSaveSlotKey(slot);
            const legacyKey = slot === 1 ? 'voxelWorldSave' : null;
            let saved = null;
            try {
                const raw = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
                if (raw) saved = JSON.parse(raw);
            } catch {}

            const btn = document.createElement('button');
            btn.style.padding = '12px';
            btn.style.background = 'rgba(255,255,255,0.08)';
            btn.style.border = '1px solid #666';
            btn.style.borderRadius = '8px';
            btn.style.color = '#fff';
            btn.style.cursor = 'pointer';
            btn.style.textAlign = 'left';

            const stamp = saved && saved.timestamp ? new Date(saved.timestamp).toLocaleString() : 'Empty';
            btn.innerHTML = `<div style="font-weight:bold">${this.getSaveSlotLabel(slot)}</div><div style="font-size:12px;color:#bbb;margin-top:4px">${stamp}</div>`;
            btn.addEventListener('click', () => {
                try { document.body.removeChild(overlay); } catch {}
                onSelect(slot);
            });
            grid.appendChild(btn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.width = '100%';
        cancelBtn.style.marginTop = '14px';
        cancelBtn.style.padding = '10px';
        cancelBtn.style.background = '#555';
        cancelBtn.style.border = 'none';
        cancelBtn.style.borderRadius = '6px';
        cancelBtn.style.color = '#fff';
        cancelBtn.style.cursor = 'pointer';
        cancelBtn.addEventListener('click', () => {
            try { document.body.removeChild(overlay); } catch {}
        });
        panel.appendChild(cancelBtn);

        document.body.appendChild(overlay);
    }

    saveWorld(slotIndex = 1) {
        try {
            const saveData = {
                version: 1,
                worldType: this.world.worldType,
                survivalMode: this.survivalMode,
                saveSlot: Math.max(1, Math.min(8, Math.round(Number(slotIndex) || 1))),
                timestamp: Date.now(),
                playerPosition: {
                    x: this.player.position.x,
                    y: this.player.position.y,
                    z: this.player.position.z
                },
                playerYaw: this.player.yaw,
                playerPitch: this.player.pitch,
                inventory: this.player.inventory,
                equipment: this.player.equipment,
                hotbarIndex: this.hotbarIndex,
                selectedBlock: this.player.selectedBlock,
                playerHealth: this.player.health,
                playerMaxHealth: this.player.maxHealth,
                playerBaseMaxHealth: this.player.baseMaxHealth,
                playerAP: this.player.ap,
                playerMaxAP: this.player.maxAP,
                playerBaseMaxAP: this.player.baseMaxAP,
                playerGold: this.player.gold,
                playerMP: this.player.mp,
                playerMaxMP: this.player.maxMP,
                playerXP: this.player.xp,
                playerLevel: this.player.level,
                dayTime: this.dayTime,
                weatherState: this.weatherState,
                lastWeatherRollNight: this.lastWeatherRollNight,
                mapWaypoints: this.mapWaypoints,
                woodDoors: (this.woodDoors || []).map(d => ({ backX: d.backX, backY: d.backY, backZ: d.backZ, lhX: d.lhX, lhZ: d.lhZ, baseY: d.baseY, baseRotY: d.baseRotY, isDZFace: d.isDZFace, isOpen: d.isOpen })),
                dungeonDoors: (this.dungeonDoors || []).map(d => ({ backX: d.backX, backY: d.backY, backZ: d.backZ, lhX: d.lhX, lhZ: d.lhZ, rhX: d.rhX, rhZ: d.rhZ, baseY: d.baseY, baseRotY: d.baseRotY, isDZFace: d.isDZFace, isOpen: d.isOpen })),
                chunks: {},
                chestStorage: Object.fromEntries(this.chestStorage),
                lockedChests: Object.fromEntries(this.lockedChests || new Map()),
                cathedralLockedChestKey: this.cathedralLockedChestKey || null,
                cauldronStorage: Object.fromEntries(this.cauldronStorage)
            };

            // Only save chunks that were actually modified by player actions (placed/destroyed blocks)
            // Skip auto-generated chunks to save space
            let savedChunkCount = 0;
            for (const [key, chunk] of this.world.chunks.entries()) {
                if (chunk.modified && chunk.playerModified) {
                    // Convert to base64 to reduce JSON size
                    const blockString = btoa(String.fromCharCode.apply(null, chunk.blocks));
                    saveData.chunks[key] = {
                        cx: chunk.cx,
                        cz: chunk.cz,
                        blocks: blockString
                    };
                    savedChunkCount++;
                    
                    // Limit saved chunks to prevent overflow (save most recent modifications)
                    if (savedChunkCount >= 50) break;
                }
            }

            const jsonString = JSON.stringify(saveData);
            const sizeKB = (jsonString.length / 1024).toFixed(2);
            
            // Check if we're approaching localStorage limit (typically 5-10MB)
            if (jsonString.length > 4 * 1024 * 1024) {
                console.warn(`Save size is large: ${sizeKB} KB`);
            }

            const saveKey = this.getSaveSlotKey(slotIndex);
            localStorage.setItem(saveKey, jsonString);
            console.log(`World saved successfully to ${saveKey}! (${savedChunkCount} chunks, ${sizeKB} KB)`);
        } catch (e) {
            console.error('Failed to save world:', e);
            const errorMsg = e.name === 'QuotaExceededError' 
                ? 'Storage quota exceeded. Try placing/destroying fewer blocks or clear old saves.'
                : 'Failed to save world: ' + e.message;
            alert(errorMsg);
        }
    }

    updateDayNightCycle(deltaTime) {
        // Compute current time-of-day, optionally frozen or overridden for astral/fairia dimensions
        let time = this.dayTime;

        if (this.inAstralDimension) {
            // Astral is always night: lock to midnight
            time = 0.0;
            this.dayTime = time;
        } else if (this.world && this.world.worldType === 'fairia') {
            // Fairia dimension: always dark with no day/night cycle
            // Keep black sky and red fog
            this.sunLight.intensity = 0.5;
            this.ambientLight.intensity = 0.5;
            this.scene.background = new THREE.Color(0x000000); // Pure black
            this.scene.fog.color = new THREE.Color(0xFF0000); // Red fog
            this.scene.fog.density = 0.02;
            return;
        } else if (!this.freezeLighting) {
            const previousTime = this.dayTime;
            const advance = deltaTime / this.dayLength;
            const rawTime = previousTime + advance;
            const daysElapsed = Math.floor(rawTime);
            time = rawTime - daysElapsed;
            this.dayTime = time;

            // Regenerate 1 MP per completed in-game day.
            if (daysElapsed > 0 && this.player && this.survivalMode) {
                const maxMp = Math.max(3, Math.min(30, Number(this.player.maxMP) || 3));
                const currentMp = Math.max(0, Math.min(maxMp, Number(this.player.mp) || 0));
                const nextMp = Math.min(maxMp, currentMp + daysElapsed);
                if (nextMp !== currentMp) {
                    this.player.maxMP = maxMp;
                    this.player.mp = nextMp;
                    this.updateMPBar();
                }
            }
        } else {
            // Lock to noon when frozen
            time = 0.5;
        }

        this.updateWeatherCycle(time);
        
        // Calculate sun angle (0 = midnight, 0.5 = noon)
        const angle = time * Math.PI * 2;
        const sunHeight = Math.sin(angle);
        const sunX = Math.cos(angle) * 200;
        const sunY = sunHeight * 200;
        const sunZ = 100;
        
        this.sunLight.position.set(sunX, Math.max(sunY, -50), sunZ);

        // Update visible sun mesh: follow camera in the sun's direction
        if (this.sunMesh) {
            const camPos = this.camera ? this.camera.position : this.player.position;
            const sunDir = new THREE.Vector3(sunX, sunY, sunZ).normalize();
            this.sunMesh.position.copy(camPos).addScaledVector(sunDir, 480);
            this.sunMesh.visible = sunHeight > -0.05 && !this.inAstralDimension &&
                !(this.world && this.world.worldType === 'fairia');
        }

        // Update moon mesh: opposite direction to sun
        if (this.moonMesh) {
            const camPos = this.camera ? this.camera.position : this.player.position;
            const moonDir = new THREE.Vector3(-sunX, -sunY, -sunZ).normalize();
            this.moonMesh.position.copy(camPos).addScaledVector(moonDir, 480);
            // Visible only at night and not in special dimensions
            const moonHeight = -sunHeight;
            this.moonMesh.visible = moonHeight > -0.05 && !this.inAstralDimension &&
                !(this.world && this.world.worldType === 'fairia');
        }
        
        // Calculate light intensity based on sun height
        // Day: bright, Night: dim
        let sunIntensity, ambientIntensity, skyColor, fogColor;
        
        // Astral dimension: dark night with minimal ambient so torches stand out
        if (this.inAstralDimension) {
            sunIntensity = 0.05;
            ambientIntensity = 0.15;
            skyColor = new THREE.Color(0x0a0a1a); // Deep night
            fogColor = new THREE.Color(0x050510);
        } else if (sunHeight > 0.2) {
            // Day time (sun is high)
            sunIntensity = 1.8;
            ambientIntensity = 1.2;
            skyColor = new THREE.Color(0x87CEEB); // Sky blue
            fogColor = new THREE.Color(0x87CEEB);
        } else if (sunHeight > -0.2) {
            // Sunrise/sunset (transition)
            const t = (sunHeight + 0.2) / 0.4; // 0 to 1
            sunIntensity = 0.4 + t * 1.4;
            ambientIntensity = 0.4 + t * 0.8;
            
            // Blend from night (dark blue) to sunrise (orange) to day (sky blue)
            if (sunHeight < 0) {
                // Night to sunrise
                const nightT = (sunHeight + 0.2) / 0.2;
                skyColor = new THREE.Color().lerpColors(
                    new THREE.Color(0x000033), // Dark blue night
                    new THREE.Color(0xFF6B35), // Orange sunrise
                    nightT
                );
            } else {
                // Sunrise to day
                const dayT = sunHeight / 0.2;
                skyColor = new THREE.Color().lerpColors(
                    new THREE.Color(0xFF6B35), // Orange sunrise
                    new THREE.Color(0x87CEEB), // Sky blue
                    dayT
                );
            }
            fogColor = skyColor.clone();
        } else {
            // Night time (sun is below horizon)
            sunIntensity = 0.1;
            ambientIntensity = 0.2;
            skyColor = new THREE.Color(0x000033); // Dark blue
            fogColor = new THREE.Color(0x000033);
        }
        
        this.sunLight.intensity = sunIntensity;
        this.ambientLight.intensity = ambientIntensity;
        // Feed skylight factor to voxel lightmaps so day/night affects baked light
        if (this.world) {
            this.world.sunlightFactor = Math.max(0, sunIntensity);
        }
        this.scene.background = skyColor;
        this.scene.fog.color = fogColor;

        this.updateAurora(time, sunHeight);
        this.updateWeatherEffects(deltaTime, time, sunHeight);

        // Day/night music: Posey.ogg during the day, campfire tales.ogg at night
        if (!this.inAstralDimension && !(this.world && this.world.worldType === 'fairia')) {
            const isNight = time >= 0.75 || time < 0.25;
            const wantTrack = isNight ? 'Campfire Tales.ogg' : 'Posey.ogg';
            if (this._currentMusicTrack !== wantTrack) {
                this._currentMusicTrack = wantTrack;
                this.gameMusic.pause();
                this.gameMusic.currentTime = 0;
                this.gameMusic.src = wantTrack;
                this.gameMusic.play().catch(e => console.log('Music play failed:', e));
            }
        }
    }

    forceUnlockAudio() {
        this.audioUnlocked = true;
        this.gameMusic.muted = false;
        if (this.gameMusic.volume < 0.65) this.gameMusic.volume = 0.65;
        this.gameMusic.play().catch(e => console.log('forceUnlockAudio play failed:', e));
    }

    ensureAudioRunning() {
        if (!this.audioUnlocked || !this.gameMusic) return;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now - this.lastAudioEnsureTime < 2500) return;
        this.lastAudioEnsureTime = now;

        if (this.gameMusic.muted) this.gameMusic.muted = false;
        if (this.gameMusic.volume < 0.65) this.gameMusic.volume = 0.65;
        if (this.gameMusic.paused && !this.pauseMenuOpen) {
            this.gameMusic.play().catch(e => console.log('ensureAudioRunning play failed:', e));
        }
    }

    createWeatherLayer() {
        this.weatherLayer = new THREE.Group();
        this.weatherLayer.visible = false;
        this.scene.add(this.weatherLayer);

        this.weatherParticles = [];
        for (let i = 0; i < 120; i++) {
            const particle = new THREE.Mesh(
                new THREE.PlaneGeometry(0.12, 2.4),
                new THREE.MeshBasicMaterial({
                    color: 0xaed8ff,
                    transparent: true,
                    opacity: 0.45,
                    depthWrite: false,
                    fog: true,
                    side: THREE.DoubleSide
                })
            );
            particle.userData.offset = new THREE.Vector3();
            particle.userData.speed = 18 + Math.random() * 12;
            particle.userData.drift = (Math.random() * 2 - 1) * 3;
            this.resetWeatherParticle(particle, true);
            this.weatherLayer.add(particle);
            this.weatherParticles.push(particle);
        }
    }

    resetWeatherParticle(particle, randomizeY = false) {
        if (!particle || !particle.userData) return;
        particle.userData.offset.x = (Math.random() * 2 - 1) * 28;
        particle.userData.offset.z = (Math.random() * 2 - 1) * 28;
        particle.userData.offset.y = randomizeY ? Math.random() * 26 : 26 + Math.random() * 8;
    }

    updateWeatherCycle(time) {
        if (this.inAstralDimension || (this.world && this.world.worldType === 'fairia')) {
            this.weatherState = 'clear';
            this.wasInNightWindow = false;
            return;
        }

        const isMidnightWindow = time < 0.1;
        if (isMidnightWindow && !this.wasInNightWindow) {
            this.lastWeatherRollNight = (this.lastWeatherRollNight | 0) + 1;
            this.weatherState = Math.random() < 0.25 ? 'active' : 'clear';
        }

        this.wasInNightWindow = isMidnightWindow;
    }

    updateWeatherEffects(deltaTime, time, sunHeight) {
        if (!this.weatherLayer || !this.weatherParticles || !this.player || !this.world || !this.world.getBiome) return;

        const biome = this.world.getBiome(this.player.position.x, this.player.position.z);
        const isSnowBiome = biome === 'snowy_forest';
        const active = this.weatherState === 'active' && !this.inAstralDimension && !(this.world && this.world.worldType === 'fairia');

        this.weatherLayer.visible = active;
        if (!active) return;

        const centerX = this.camera ? this.camera.position.x : this.player.position.x;
        const centerY = (this.camera ? this.camera.position.y : this.player.position.y) + 12;
        const centerZ = this.camera ? this.camera.position.z : this.player.position.z;
        const now = performance.now() * 0.001;

        for (const particle of this.weatherParticles) {
            const mat = particle.material;
            if (isSnowBiome) {
                mat.color.setHex(0xf4fbff);
                mat.opacity = 0.7;
                particle.scale.set(2.8, 0.8, 1);
                particle.rotation.z = Math.sin(now + particle.userData.drift) * 0.35;
                particle.userData.offset.y -= deltaTime * (4 + particle.userData.speed * 0.18);
                particle.userData.offset.x += deltaTime * particle.userData.drift;
            } else {
                mat.color.setHex(0xaed8ff);
                mat.opacity = 0.42;
                particle.scale.set(1, 1, 1);
                particle.rotation.z = 0.08;
                particle.userData.offset.y -= deltaTime * particle.userData.speed;
                particle.userData.offset.x += deltaTime * 1.2;
            }

            if (particle.userData.offset.y < -8) {
                this.resetWeatherParticle(particle, false);
            }

            particle.position.set(
                centerX + particle.userData.offset.x,
                centerY + particle.userData.offset.y,
                centerZ + particle.userData.offset.z
            );
        }
    }

    createAuroraLayer() {
        this.auroraLayer = new THREE.Group();
        this.auroraLayer.visible = false;
        this.scene.add(this.auroraLayer);

        this.auroraCurtains = [];
        const auroraBands = [
            { color: 0x3dff8f, offsetX: -320, offsetZ: -250, baseY: 138, width: 240, height: 130, opacity: 0.26 },
            { color: 0x61ffd1, offsetX: -150, offsetZ: -235, baseY: 144, width: 280, height: 138, opacity: 0.22 },
            { color: 0x8cf7ff, offsetX: 0, offsetZ: -225, baseY: 148, width: 320, height: 142, opacity: 0.2 },
            { color: 0x61ffd1, offsetX: 150, offsetZ: -235, baseY: 144, width: 280, height: 138, opacity: 0.22 },
            { color: 0x3dff8f, offsetX: 320, offsetZ: -250, baseY: 138, width: 240, height: 130, opacity: 0.26 }
        ];

        for (let i = 0; i < auroraBands.length; i++) {
            const band = auroraBands[i];
            const curtain = new THREE.Mesh(
                new THREE.PlaneGeometry(band.width, band.height, 32, 12),
                new THREE.MeshBasicMaterial({
                    color: band.color,
                    transparent: true,
                    opacity: band.opacity,
                    depthWrite: false,
                    fog: false,
                    side: THREE.DoubleSide,
                    blending: THREE.AdditiveBlending
                })
            );
            curtain.userData.phase = i * 1.15;
            curtain.userData.offsetX = band.offsetX;
            curtain.userData.offsetZ = band.offsetZ;
            curtain.userData.baseY = band.baseY;
            curtain.userData.baseOpacity = band.opacity;
            this.auroraLayer.add(curtain);
            this.auroraCurtains.push(curtain);
        }
    }

    updateAurora(time, sunHeight) {
        if (!this.auroraLayer || !this.player || !this.world || !this.world.getBiome) return;

        const biome = this.world.getBiome(this.player.position.x, this.player.position.z);
        const isSnowy = biome === 'snowy_forest';
        const isNight = sunHeight <= -0.05 || time >= 0.75 || time < 0.25;
        const allowed = isSnowy && isNight && !this.inAstralDimension && !(this.world && this.world.worldType === 'fairia');

        this.auroraLayer.visible = allowed;
        if (!allowed) return;

        const now = performance.now() * 0.001;
        const camX = this.camera ? this.camera.position.x : this.player.position.x;
        const camZ = this.camera ? this.camera.position.z : this.player.position.z;

        for (const curtain of this.auroraCurtains) {
            const phase = curtain.userData.phase;
            curtain.position.set(
                camX + curtain.userData.offsetX + Math.sin(now * 0.12 + phase) * 26,
                curtain.userData.baseY + Math.sin(now * 0.8 + phase) * 7,
                camZ + curtain.userData.offsetZ + Math.cos(now * 0.1 + phase) * 10
            );
            curtain.rotation.y = Math.sin(now * 0.08 + phase) * 0.28;
            curtain.material.opacity = curtain.userData.baseOpacity + Math.sin(now * 1.35 + phase) * 0.06;
        }
    }

    createCloudLayer() {
        this.cloudLayer = new THREE.Group();
        this.cloudLayer.renderOrder = -10;
        this.scene.add(this.cloudLayer);

        this.cloudParticles = [];
        this.cloudSpawnRadius = 420;
        this.cloudResetDistance = 470;
        this.cloudDriftSpeed = 6;

        const cloudMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.82,
            depthWrite: false,
            fog: false,
            side: THREE.DoubleSide
        });

        for (let i = 0; i < 18; i++) {
            const width = 36 + Math.random() * 42;
            const height = 12 + Math.random() * 8;
            const cloud = new THREE.Mesh(
                new THREE.PlaneGeometry(width, height),
                cloudMaterial.clone()
            );
            cloud.rotation.x = -Math.PI / 2;
            cloud.userData.width = width;
            cloud.userData.height = height;
            cloud.userData.offset = new THREE.Vector3();
            cloud.userData.speedScale = 0.65 + Math.random() * 0.8;
            cloud.userData.bobPhase = Math.random() * Math.PI * 2;
            cloud.userData.baseY = 160 + Math.random() * 36;
            this.resetCloud(cloud, true);
            this.cloudLayer.add(cloud);
            this.cloudParticles.push(cloud);
        }
    }

    resetCloud(cloud, randomizeX = false) {
        if (!cloud || !cloud.userData) return;
        const spawnRadius = this.cloudSpawnRadius || 420;
        const offset = cloud.userData.offset || new THREE.Vector3();
        offset.x = randomizeX
            ? (Math.random() * 2 - 1) * spawnRadius
            : -spawnRadius - Math.random() * 120;
        offset.z = (Math.random() * 2 - 1) * spawnRadius;
        cloud.userData.offset = offset;
        cloud.userData.baseY = 160 + Math.random() * 36;
        cloud.position.set(offset.x, cloud.userData.baseY, offset.z);
    }

    updateCloudLayer(deltaTime) {
        if (!this.cloudParticles || !this.cloudParticles.length || !this.camera) return;

        const centerX = this.camera.position.x;
        const centerZ = this.camera.position.z;
        const drift = (this.cloudDriftSpeed || 6) * deltaTime;
        const resetDistance = this.cloudResetDistance || 470;

        for (const cloud of this.cloudParticles) {
            const data = cloud.userData;
            data.offset.x += drift * data.speedScale;

            if (data.offset.x > resetDistance) {
                this.resetCloud(cloud, false);
            }

            const bob = Math.sin((performance.now() * 0.001) + data.bobPhase) * 1.4;
            cloud.position.set(
                centerX + data.offset.x,
                data.baseY + bob,
                centerZ + data.offset.z
            );
        }

        this.cloudLayer.visible = !this.inAstralDimension && !(this.world && this.world.worldType === 'fairia');
    }

    applyFairiaHeatDamage() {
        if (!this.survivalMode || !this.player || this.player.isDead) return;
        const inFairia = this.inFairiaDimension || (this.world && this.world.worldType === 'fairia');
        if (!inFairia) return;

        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now < (this.chillProtectionUntil || 0)) return;
        // Burn tick every 2 seconds while in Fairia.
        if (now - this.lastFairiaHeatDamageTime < 2000) return;
        this.lastFairiaHeatDamageTime = now;

        const before = this.player.health;
        this.player.takeDamage(1, null);
        if (this.player.health < before) {
            this.showHeatWarningPopup();
        }
        this.updateHealthBar();
    }

    checkFairiaPortalTouch() {
        if (!this.world || !this.player) return;
        if (this.inFairiaDimension || this.inAstralDimension) return;

        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now < this.portalTouchCooldownUntil) return;

        const portalType = this.FAIRIA_PORTAL_BLOCK_TYPE || 46;
        const px = this.player.position.x;
        const py = this.player.position.y;
        const pz = this.player.position.z;

        // Sample a small 3x3 footprint over three body heights to detect contact reliably.
        const xs = [Math.floor(px - 0.32), Math.floor(px), Math.floor(px + 0.32)];
        const ys = [Math.floor(py - 0.95), Math.floor(py - 0.2), Math.floor(py + 0.6)];
        const zs = [Math.floor(pz - 0.32), Math.floor(pz), Math.floor(pz + 0.32)];

        for (const x of xs) {
            for (const y of ys) {
                for (const z of zs) {
                    if (this.world.getBlock(x, y, z) === portalType) {
                        this.portalTouchCooldownUntil = now + 2000;
                        this.enterFairiaDimension(true);
                        return;
                    }
                }
            }
        }
    }

    showChillProtectionPopup() {
        if (!this._heatPopupEl) {
            this.showHeatWarningPopup();
        }
        const popup = this._heatPopupEl;
        if (!popup) return;

        popup.textContent = 'CHILLING ACTIVE (5:00)';
        popup.style.background = 'rgba(30, 90, 170, 0.9)';
        popup.style.border = '1px solid rgba(150, 220, 255, 0.95)';
        popup.style.color = '#eaf8ff';
        popup.style.opacity = '1';

        if (this._heatPopupTimeout) {
            clearTimeout(this._heatPopupTimeout);
            this._heatPopupTimeout = null;
        }
        this._heatPopupTimeout = setTimeout(() => {
            if (this._heatPopupEl) {
                this._heatPopupEl.style.opacity = '0';
                this._heatPopupEl.textContent = 'HEAT -1 HP';
                this._heatPopupEl.style.background = 'rgba(190, 40, 20, 0.9)';
                this._heatPopupEl.style.border = '1px solid rgba(255, 170, 120, 0.95)';
                this._heatPopupEl.style.color = '#ffe8d2';
            }
            this._heatPopupTimeout = null;
        }, 1200);
    }

    showHeatWarningPopup() {
        if (!this._heatPopupEl) {
            const popup = document.createElement('div');
            popup.id = 'fairia-heat-popup';
            popup.textContent = 'HEAT -1 HP';
            popup.style.position = 'fixed';
            popup.style.left = '50%';
            popup.style.top = '18%';
            popup.style.transform = 'translate(-50%, 0)';
            popup.style.padding = '8px 14px';
            popup.style.background = 'rgba(190, 40, 20, 0.9)';
            popup.style.border = '1px solid rgba(255, 170, 120, 0.95)';
            popup.style.borderRadius = '6px';
            popup.style.color = '#ffe8d2';
            popup.style.fontFamily = 'monospace';
            popup.style.fontWeight = 'bold';
            popup.style.fontSize = '13px';
            popup.style.letterSpacing = '0.6px';
            popup.style.zIndex = '1200';
            popup.style.pointerEvents = 'none';
            popup.style.opacity = '0';
            popup.style.transition = 'opacity 0.2s ease';
            document.body.appendChild(popup);
            this._heatPopupEl = popup;
        }

        const popup = this._heatPopupEl;
        if (!popup) return;

        popup.style.opacity = '1';
        if (this._heatPopupTimeout) {
            clearTimeout(this._heatPopupTimeout);
            this._heatPopupTimeout = null;
        }
        this._heatPopupTimeout = setTimeout(() => {
            if (this._heatPopupEl) this._heatPopupEl.style.opacity = '0';
            this._heatPopupTimeout = null;
        }, 700);
    }

    updateChillHUD() {
        const remaining = this.chillProtectionUntil - Date.now();
        if (remaining <= 0) {
            if (this._chillHudEl) {
                this._chillHudEl.style.display = 'none';
            }
            return;
        }

        if (!this._chillHudEl) {
            const el = document.createElement('div');
            el.id = 'chill-hud';
            el.style.position = 'fixed';
            el.style.left = '50%';
            el.style.top = '10%';
            el.style.transform = 'translate(-50%, 0)';
            el.style.padding = '5px 12px';
            el.style.background = 'rgba(20, 70, 140, 0.82)';
            el.style.border = '1px solid rgba(140, 210, 255, 0.85)';
            el.style.borderRadius = '6px';
            el.style.color = '#c8eeff';
            el.style.fontFamily = 'monospace';
            el.style.fontWeight = 'bold';
            el.style.fontSize = '12px';
            el.style.zIndex = '1199';
            el.style.pointerEvents = 'none';
            document.body.appendChild(el);
            this._chillHudEl = el;
        }

        const secs = Math.ceil(remaining / 1000);
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        this._chillHudEl.textContent = `\u2744 Chill: ${m}m ${s < 10 ? '0' : ''}${s}s`;
        this._chillHudEl.style.display = 'block';
    }

    hasCloudPillowEquipped() {
        const offHand = this.player && this.player.equipment ? this.player.equipment.offHand : 0;
        const type = (offHand && typeof offHand === 'object') ? offHand.type : offHand;
        return type === 31;
    }

    isNightTime() {
        const t = this.dayTime;
        return t >= 0.75 || t < 0.25;
    }

    isMapEquipped() {
        if (!this.player || !this.player.equipment) return false;
        const equip = this.player.equipment;
        for (let i = 1; i <= 7; i++) {
            const slot = equip[`accessory${i}`];
            const type = slot && typeof slot === 'object' ? slot.type : slot;
            if (type === this.MAP_TYPE) return true;
        }
        return false;
    }

    updateMinimap() {
        if (!this._minimapEl || !this._minimapCanvas || !this.player || !this.world) return;

        const equipped = this.isMapEquipped();
        this._minimapEl.style.display = equipped ? 'block' : 'none';
        if (!equipped) return;

        const canvas = this._minimapCanvas;
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        const halfW = W >> 1;
        const halfH = H >> 1;
        const chunkSize = this.world.chunkSize || 16;
        const waterLevel = this.world.waterLevel || 44;

        // Square minimap in chunk cells (box-shape discovered map)
        const cellsAcross = 25;
        const cellPx = Math.floor(W / cellsAcross);
        const halfCells = Math.floor(cellsAcross / 2);
        const pcx = Math.floor(this.player.position.x / chunkSize);
        const pcz = Math.floor(this.player.position.z / chunkSize);

        const dimensionKey = this.getCurrentDimensionKey();
        if (!this.discoveredChunks) this.discoveredChunks = { default: new Set(), fairia: new Set(), astral: new Set() };
        if (!this.mapWaypoints) this.mapWaypoints = { default: [], fairia: [], astral: [] };
        const discovered = this.discoveredChunks[dimensionKey] || (this.discoveredChunks[dimensionKey] = new Set());
        const waypoints = this.mapWaypoints[dimensionKey] || (this.mapWaypoints[dimensionKey] = []);

        // Mark currently loaded chunks as discovered land
        if (this.world.chunks) {
            for (const key of this.world.chunks.keys()) discovered.add(key);
        }
        discovered.add(`${pcx},${pcz}`);

        // Background + border
        ctx.fillStyle = '#0f1014';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = '#2b2f3a';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

        for (let dz = -halfCells; dz <= halfCells; dz++) {
            for (let dx = -halfCells; dx <= halfCells; dx++) {
                const cx = pcx + dx;
                const cz = pcz + dz;
                const key = `${cx},${cz}`;

                const sx = (dx + halfCells) * cellPx;
                const sy = (dz + halfCells) * cellPx;

                if (!discovered.has(key)) {
                    ctx.fillStyle = '#151821';
                    ctx.fillRect(sx, sy, cellPx, cellPx);
                    continue;
                }

                const wx = cx * chunkSize + Math.floor(chunkSize / 2);
                const wz = cz * chunkSize + Math.floor(chunkSize / 2);
                const terrainH = this.world.getTerrainHeight(wx, wz);
                const biome = this.world.getBiome ? this.world.getBiome(wx, wz) : 'forest';

                let color = '#2f7a36';
                if (terrainH <= waterLevel) {
                    color = '#2a5fbf';
                } else if (biome === 'desert') {
                    color = '#c2b280';
                } else if (biome === 'snowy_forest') {
                    color = '#d6e6f4';
                } else if (biome === 'hell_swamp') {
                    color = '#5d2948';
                } else if (biome === 'fairia') {
                    color = '#8b2a2a';
                }

                ctx.fillStyle = color;
                ctx.fillRect(sx, sy, cellPx, cellPx);
            }
        }

        // Player marker and facing arrow at center
        ctx.save();
        ctx.translate(halfW, halfH);
        ctx.fillStyle = '#ffe600';
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const arrowLen = 10;
        const angle = this.player.yaw;
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.sin(angle) * arrowLen, -Math.cos(angle) * arrowLen);
        ctx.stroke();
        ctx.restore();

        // Waypoint markers in current dimension
        ctx.save();
        const pxPerBlock = cellPx / chunkSize;
        for (const waypoint of waypoints) {
            const dxBlocks = waypoint.x - this.player.position.x;
            const dzBlocks = waypoint.z - this.player.position.z;
            const sx = halfW + (dxBlocks * pxPerBlock);
            const sy = halfH + (dzBlocks * pxPerBlock);
            if (sx < 0 || sx > W || sy < 0 || sy > H) continue;

            ctx.strokeStyle = '#ff4d4d';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sx - 4, sy - 4);
            ctx.lineTo(sx + 4, sy + 4);
            ctx.moveTo(sx + 4, sy - 4);
            ctx.lineTo(sx - 4, sy + 4);
            ctx.stroke();

            if (waypoint.label) {
                ctx.fillStyle = '#ffd6d6';
                ctx.font = 'bold 9px monospace';
                ctx.textAlign = 'left';
                ctx.fillText(waypoint.label, sx + 6, sy - 6);
            }
        }
        ctx.restore();

        // Compass labels
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('N', halfW, 10);
        ctx.fillText('S', halfW, H - 2);
        ctx.textAlign = 'left';
        ctx.fillText('W', 2, halfH + 4);
        ctx.textAlign = 'right';
        ctx.fillText('E', W - 2, halfH + 4);
        ctx.restore();
    }

    clearChunkMeshes() {
        if (!this.chunkMeshes) return;
        for (const mesh of this.chunkMeshes.values()) {
            try {
                this.scene.remove(mesh);
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) {
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach(m => m && m.dispose && m.dispose());
                    } else if (mesh.material.dispose) {
                        mesh.material.dispose();
                    }
                }
            } catch {}
        }
        this.chunkMeshes.clear();
        if (this.chunkBounds) this.chunkBounds.clear();
    }

    clearTorchLights() {
        if (!this.torchLights) return;
        for (const light of this.torchLights.values()) {
            try { this.scene.remove(light); } catch {}
        }
        this.torchLights.clear();
    }

    saveDimensionState() {
        // Remove visuals but keep world data so we can regenerate meshes on return
        this.clearChunkMeshes();
        this.clearTorchLights();

        return {
            world: this.world,
            dayTime: this.dayTime,
            weatherState: this.weatherState,
            lastWeatherRollNight: this.lastWeatherRollNight,
            playerPos: this.player.position.clone(),
            playerYaw: this.player.yaw,
            playerPitch: this.player.pitch,
            chestStorage: this.chestStorage,
            lockedChests: this.lockedChests,
            cathedralLockedChestKey: this.cathedralLockedChestKey,
            candleStorage: this.candleStorage,
            cauldronStorage: this.cauldronStorage
        };
    }

    enterAstralDimension() {
        if (this.inAstralDimension) return;
        if (!this.hasCloudPillowEquipped()) return;
        if (!this.isNightTime()) return;

        this.astralReturnState = this.saveDimensionState();

        // Switch to astral world (floating islands, always night)
        this.world = new VoxelWorld('astral');
        this.dayTime = 0.75;
        this.inAstralDimension = true;
        this.chunkMeshes = new Map();
        this.chunkBounds = new Map();
        this.chunkMeshQueue = [];
        this.generatingChunkMesh = false;
        this.torchLights = new Map();
        this.chestStorage = new Map();
        this.lockedChests = new Map();
        this.cathedralLockedChestKey = null;
        this.candleStorage = new Map();
        this.cauldronStorage = new Map();
        this.mesher = new BlockMesher(this.world, this.textureAtlas);
        if (this.itemManager) this.itemManager.world = this.world;

        // Place player above the astral spawn platform.
        this.player.position.set(0, 108, 0);
        this.player.velocity.set(0, 0, 0);
        this.player.yaw = 0;
        this.player.pitch = 0;

        this.generateInitialChunks();
        setTimeout(() => {
            this.createAstralLockedCathedralChest();
        }, 200);
        
        // Add cathedral torch lights after a brief delay to ensure chunks are rendered
        setTimeout(() => {
            if (!this.useRuntimeTorchLights) {
                console.log('Skipping cathedral PointLight setup: using lightmaps for torch lighting');
                return;
            }
            const cathedralFloorY = 75;
            const cathedralMinX = -15;
            const cathedralMaxX = 15;
            const cathedralMinZ = -15;
            const cathedralMaxZ = 15;
            const torchY = cathedralFloorY + 2;
            
            const torchPositions = [
                [cathedralMinX + 1, torchY, cathedralMinZ + 1],
                [cathedralMaxX - 1, torchY, cathedralMinZ + 1],
                [cathedralMinX + 1, torchY, cathedralMaxZ - 1],
                [cathedralMaxX - 1, torchY, cathedralMaxZ - 1]
            ];
            
            // Clear existing lights first
            if (this.torchLights) {
                for (const light of this.torchLights.values()) {
                    this.scene.remove(light);
                }
                this.torchLights.clear();
            }
            
            for (const [tx, ty, tz] of torchPositions) {
                const lightKey = `${tx},${ty},${tz}`;
                const torchLight = new THREE.PointLight(0xFFAA55, 15.0, 100); // Very bright with large range
                torchLight.position.set(tx + 0.5, ty + 0.5, tz + 0.5);
                torchLight.castShadow = false;
                torchLight.decay = 1; // Less aggressive falloff
                this.scene.add(torchLight);
                this.torchLights.set(lightKey, torchLight);
                console.log(`Added cathedral torch light at world pos: ${tx + 0.5}, ${ty + 0.5}, ${tz + 0.5}`);
                console.log(`  Light properties - intensity: ${torchLight.intensity}, distance: ${torchLight.distance}, decay: ${torchLight.decay}`);
            }
            
            console.log(`Total lights in scene: ${this.torchLights.size}`);
            console.log(`Player spawn Y: ${this.player.position.y}, Cathedral torch Y: ${torchY}`);
            console.log(`Renderer info:`, this.renderer.info);
        }, 100);
        
        // Spawn pigmen and priest boss in the astral cathedral after chunks load
        setTimeout(() => {
            this.spawnAstralPigmen(8);
            this.spawnpiggronPriest();
        }, 500);
        
        console.log('Entered astral dimension');
    }

    enterFairiaDimension(fromPortal = false) {
        if (this.inFairiaDimension) return;
        if (this.inAstralDimension) {
            console.log('Exit astral before entering fairia.');
            return;
        }

        this.fairiaReturnState = this.saveDimensionState();

        // Switch to fairia world and keep player location similar to astral state workflow.
        this.world = new VoxelWorld('fairia');
        this.dayTime = 0.75;
        this.weatherState = 'clear';
        this.lastWeatherRollNight = -1;
        this.inFairiaDimension = true;
        this.chunkMeshes = new Map();
        this.chunkBounds = new Map();
        this.chunkMeshQueue = [];
        this.generatingChunkMesh = false;
        this.torchLights = new Map();
        this.chestStorage = new Map();
        this.candleStorage = new Map();
        this.cauldronStorage = new Map();
        this.mesher = new BlockMesher(this.world, this.textureAtlas);
        if (this.itemManager) this.itemManager.world = this.world;

        if (fromPortal && this.fairiaReturnState && this.fairiaReturnState.playerPos) {
            // Portal entry: keep roughly same X/Z (top-right overworld area), place just under Fairia roof.
            const edge = (this.world.worldChunkRadius * this.world.chunkSize) - 2;
            const src = this.fairiaReturnState.playerPos;
            const spawnX = Math.max(-edge, Math.min(edge, src.x));
            const spawnZ = Math.max(-edge, Math.min(edge, src.z));
            const underRoofY = this.world.chunkHeight - 4;
            this.player.position.set(spawnX, underRoofY, spawnZ);
        } else if (this.fairiaReturnState && this.fairiaReturnState.playerPos) {
            this.player.position.copy(this.fairiaReturnState.playerPos);
        }
        this.player.velocity.set(0, 0, 0);

        // Switch to Fairia track immediately.
        this.gameMusic.pause();
        this.gameMusic.currentTime = 0;
        this.gameMusic.src = 'Hells Kingdom.ogg';
        this._currentMusicTrack = 'Hells Kingdom.ogg';
        setTimeout(() => {
            this.gameMusic.play().catch(e => console.log('Fairia music play failed:', e));
        }, 100);

        this.generateInitialChunks();
        console.log('Entered fairia dimension');
    }

    exitFairiaDimension() {
        if (!this.inFairiaDimension) return;
        if (!this.fairiaReturnState) return;

        // Clean up fairia visuals
        this.clearChunkMeshes();
        this.clearTorchLights();

        // Restore previous state (same pattern as astral exit)
        const state = this.fairiaReturnState;
        this.world = state.world;
        this.dayTime = state.dayTime;
        this.weatherState = state.weatherState || 'clear';
        this.lastWeatherRollNight = Number.isFinite(state.lastWeatherRollNight) ? state.lastWeatherRollNight : -1;
        this.player.position.copy(state.playerPos);
        this.player.velocity.set(0, 0, 0);
        this.player.yaw = state.playerYaw;
        this.player.pitch = state.playerPitch;
        this.chunkMeshes = new Map();
        this.chunkBounds = new Map();
        this.chunkMeshQueue = [];
        this.generatingChunkMesh = false;
        this.torchLights = new Map();
        this.chestStorage = state.chestStorage || new Map();
        this.lockedChests = state.lockedChests || new Map();
        this.cathedralLockedChestKey = state.cathedralLockedChestKey || null;
        this.candleStorage = state.candleStorage || new Map();
        this.cauldronStorage = state.cauldronStorage || new Map();
        this.mesher = new BlockMesher(this.world, this.textureAtlas);
        if (this.itemManager) this.itemManager.world = this.world;

        this.inFairiaDimension = false;
        this.fairiaReturnState = null;

        // Restore non-fairia music; day/night system will swap if needed.
        if (!this.inAstralDimension && this.world && this.world.worldType !== 'fairia') {
            this.gameMusic.pause();
            this.gameMusic.currentTime = 0;
            this.gameMusic.src = 'Posey.ogg';
            this._currentMusicTrack = 'Posey.ogg';
            setTimeout(() => {
                this.gameMusic.play().catch(e => console.log('Default music play failed:', e));
            }, 100);
        }

        this.generateInitialChunks();
        console.log('Returned from fairia dimension');
    }

    exitAstralDimension() {
        if (!this.inAstralDimension) return;
        if (!this.astralReturnState) return;

        // Clean up astral visuals
        this.clearChunkMeshes();
        this.clearTorchLights();

        // Restore overworld state
        const state = this.astralReturnState;
        this.world = state.world;
        this.dayTime = state.dayTime;
        this.weatherState = state.weatherState || 'clear';
        this.lastWeatherRollNight = Number.isFinite(state.lastWeatherRollNight) ? state.lastWeatherRollNight : -1;
        this.player.position.copy(state.playerPos);
        this.player.velocity.set(0, 0, 0);
        this.player.yaw = state.playerYaw;
        this.player.pitch = state.playerPitch;
        this.chunkMeshes = new Map();
        this.chunkBounds = new Map();
        this.chunkMeshQueue = [];
        this.generatingChunkMesh = false;
        this.torchLights = new Map();
        this.chestStorage = state.chestStorage || new Map();
        this.lockedChests = state.lockedChests || new Map();
        this.cathedralLockedChestKey = state.cathedralLockedChestKey || null;
        this.candleStorage = state.candleStorage || new Map();
        this.cauldronStorage = state.cauldronStorage || new Map();
        this.mesher = new BlockMesher(this.world, this.textureAtlas);
        if (this.itemManager) this.itemManager.world = this.world;

        this.inAstralDimension = false;
        this.astralReturnState = null;

        this.generateInitialChunks();
        console.log('Returned from astral dimension');
    }

    animate = () => {
        requestAnimationFrame(this.animate);

        try {
            const deltaTime = this.clock.getDelta();

            // Poll gamepad input every frame
            this.updateGamepadInput();

            // If paused, just render current frame without updating game state
            if (this.pauseMenuOpen) {
                this.renderer.render(this.scene, this.camera);
                return;
            }
            
            // Check for death in survival mode
            if (this.survivalMode && this.player.isDead) {
                this.showDeathScreen();
                return;
            }
            
            // Update day/night cycle
            this.updateDayNightCycle(deltaTime);
            this.updateCloudLayer(deltaTime);
            this.updatePrimedTNT();
            this.ensureAudioRunning();
            this.applyFairiaHeatDamage();
            this.updateChillHUD();

            // Update minimap (every 20 frames)
            this._minimapFrame = (this._minimapFrame || 0) + 1;
            if (this._minimapFrame % 20 === 0) this.updateMinimap();

            // Publish dynamic closed-door colliders for player physics.
            this.world.closedDoorCollisionBoxes = this.getClosedDoorCollisionBoxes();
            
            // Update player
            this.player.update(this.world, deltaTime);
            if (this.player.groundPoundImpactPending) {
                this.applyGroundPoundDamage();
                this.player.groundPoundImpactPending = false;
            }
            this.checkFairiaPortalTouch();
            // Update creatures
            this.updateSquirrels(deltaTime);
            this.updateSacculariusMoles(deltaTime);
            this.updateTestSalesmen(deltaTime);
            // Update hostile mobs
            this.updatePigmen(deltaTime);
            this.updateSlimes(deltaTime);
            // Refresh mob population - despawn far ones, spawn near ones
            this.refreshMobPopulation();
            // Validate doors and NPCs are still in scene
            this.validateDoorsAndNPCs();
            if (this.piggronPriest && !this.piggronPriest.isDead) {
                this.piggronPriest.update(this.world, this.player, deltaTime);
            }
            this.updateMinutors(deltaTime);
            
            // Update Phinox mount
            if (this.phinox) {
                const keys = (this.player && this.player.keys) ? this.player.keys : {};
                const playerInput = this.isMountedOnPhinox ? {
                    forward: !!(keys['w'] || keys['arrowup']),
                    backward: !!(keys['s'] || keys['arrowdown']),
                    left: !!(keys['a'] || keys['arrowleft']),
                    right: !!(keys['d'] || keys['arrowright']),
                    // Spacebar is stored as a literal space in our key map
                    jump: !!(keys[' '] || keys['space']),
                    // Support generic 'shift' key for sneak
                    sneak: !!(keys['shift'])
                } : null;

                this.phinox.update(deltaTime, playerInput, this.world);
                
                // Sync player/mount when mounted: yaw from mouse (player), position from mount
                if (this.isMountedOnPhinox) {
                    this.phinox.yaw = this.player.yaw;
                    this.player.position.copy(this.phinox.position);
                    this.player.position.y += 1; // Sit on top
                    this.player.velocity.set(0, 0, 0); // Cancel player physics
                }
            }
            
            // Update dropped items
            if (this.itemManager) {
                const pickedUp = this.itemManager.update(this.player, deltaTime);
                // Update inventory UI if item was picked up
                if (pickedUp && this.inventoryOpen) {
                    this.updateInventoryUI();
                }
            }

            // Animate doors
            this.updateDoorAnimations(deltaTime);
            this.updateSconceSmoke(deltaTime);

            // Update any active projectiles (bullets)
            if (this.projectiles && this.projectiles.length) {
                for (let i = this.projectiles.length - 1; i >= 0; i--) {
                    const proj = this.projectiles[i];
                    const keep = proj.update(deltaTime, this);
                    if (!keep) this.projectiles.splice(i, 1);
                }
            }
            
            // Update visible chunks
            // Clamp player to world boundary (87×87 chunks, radius 43)
            {
                const limit = (this.world.worldChunkRadius * this.world.chunkSize) - 1; // 687
                this.player.position.x = Math.max(-limit, Math.min(limit, this.player.position.x));
                this.player.position.z = Math.max(-limit, Math.min(limit, this.player.position.z));
            }
            this.updateVisibleChunks();

            // Update block break progress fill
            this.updateBreakProgress();

            // Move block highlight to the targeted block
            if (this.blockHighlight) {
                const hit = this.raycastBlock();
                if (hit) {
                    this.blockHighlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
                    this.blockHighlight.visible = true;
                } else {
                    this.blockHighlight.visible = false;
                }
            }

            // Update camera
            if (!this.thirdPerson) {
                // First-person: use player's camera and attach hand block
                this.camera = this.player.getCamera();
                if (this.handBlock && this.handBlock.parent !== this.camera) {
                    try { this.camera.add(this.handBlock); } catch (e) {}
                }
                if (this.playerModel) this.playerModel.visible = false;

                // Update hand block (rotating held block)
                this.updateHandBlock();
                // Update weapon mesh (first-person)
                this.updateHandItem();
            } else {
                // Third-person: orbit camera behind player using yaw for bearing and pitch for tilt
                const headOffset = new THREE.Vector3(0, 1.5, 0);
                const headPos = this.player.position.clone().add(headOffset);

                const horizontalRadius = this.thirdPersonDistance * Math.cos(this.player.pitch);
                const verticalOffset = this.thirdPersonDistance * Math.sin(this.player.pitch);

                // Direction pointing backward relative to player facing
                const behindDir = new THREE.Vector3(
                    Math.sin(this.player.yaw + Math.PI),
                    0,
                    Math.cos(this.player.yaw + Math.PI)
                );

                const desiredCamPos = headPos.clone()
                    .addScaledVector(behindDir, horizontalRadius)
                    .add(new THREE.Vector3(0, verticalOffset, 0));

                this.thirdCamera.position.copy(desiredCamPos);
                this.thirdCamera.lookAt(headPos);
                this.camera = this.thirdCamera;
                // ensure handBlock is not attached to camera in third-person
                if (this.handBlock && this.handBlock.parent) {
                    try { this.handBlock.parent.remove(this.handBlock); } catch (e) {}
                }
                if (this.playerModel) this.playerModel.visible = true;
            }

            // Update player model
            this.updatePlayerModel();
            // Update visual weapons on third-person model
            this.updatePlayerWeaponModel();

            // Animate cape if player has one
            if (this.playerCape) {
                const time = Date.now() * 0.001; // Convert to seconds
                const posAttr = this.playerCape.geometry.getAttribute('position');
                const positions = posAttr.array;
                const basePos = this.playerCape.userData.basePositions;
                
                // Apply wave animation to cape vertices
                for (let i = 0; i < positions.length; i += 3) {
                    const y = basePos[i + 1];
                    // Add wind sway based on y position (more sway at bottom)
                    const sway = Math.sin(time * 2 + y * 3) * 0.05;
                    positions[i] = basePos[i] + sway;
                    positions[i + 1] = basePos[i + 1];
                    positions[i + 2] = basePos[i + 2] + Math.cos(time * 1.5 + y * 2) * 0.03;
                }
                posAttr.needsUpdate = true;
            }

            // Update other player if multiplayer
            if (this.isMultiplayer && this.otherPlayerModel) {
                this.otherPlayerModel.position.copy(this.otherPlayer.position);
                this.otherPlayerModel.rotation.y = this.otherPlayer.yaw;
                // Make other player's name label face camera
                this.otherPlayerModel.children.forEach(child => {
                    if (child.userData.isNameLabel) {
                        child.lookAt(this.camera.position);
                    }
                });
                // if the bot has a weapon property use it (future enhancement)
                if (this.otherPlayerWeaponType !== this.otherPlayer.equipment?.mainHand) {
                    // recreate simplified weapon on other player
                    if (this.otherPlayerWeaponMesh) {
                        this.otherPlayerModel.remove(this.otherPlayerWeaponMesh);
                        this.otherPlayerWeaponMesh = null;
                    }
                    const wt = this.otherPlayer.equipment ? this.otherPlayer.equipment.mainHand : 0;
                    const ttype = (wt && typeof wt === 'object') ? wt.type : wt;
                    if (ttype === 22 || ttype === 32 || ttype === 23) {
                        this.otherPlayerWeaponMesh = this.createWeaponMesh(ttype);
                        this.otherPlayerWeaponMesh.position.set(0.4, 0.0, 0.1);
                        this.otherPlayerWeaponMesh.rotation.y = -Math.PI/2;
                        this.otherPlayerModel.add(this.otherPlayerWeaponMesh);
                    }
                    this.otherPlayerWeaponType = ttype;
                }
            }

            // Update remote player models from server
            if (this.remotePlayers && this.remotePlayerModels) {
                for (const [id, playerData] of this.remotePlayers.entries()) {
                    const model = this.remotePlayerModels.get(id);
                    if (model && playerData) {
                        model.position.set(playerData.x || 0, playerData.y || 70, playerData.z || 0);
                        model.rotation.y = playerData.yaw || 0;
                        // Make name label face camera
                        model.children.forEach(child => {
                            if (child.userData.isNameLabel) {
                                child.lookAt(this.camera.position);
                            }
                        });
                    }
                }
            }

            // Render
            this.renderer.render(this.scene, this.camera);

            // FPS counter
            this.frameCount++;
            this.lastFrameTime += deltaTime;
            if (this.lastFrameTime >= 1.0) {
                this.fps = Math.round(this.frameCount / this.lastFrameTime);
                this.frameCount = 0;
                this.lastFrameTime = 0;
            }

            this.updateUI();
            
            // Update health bar in survival mode
            if (this.survivalMode) {
                this.updateHealthBar();
            }

            // Periodically send our player state to server
            if (this.ws && this.ws.readyState === 1) {
                try {
                    this.ws.send(JSON.stringify({
                        type: 'state',
                        x: this.player.position.x,
                        y: this.player.position.y,
                        z: this.player.position.z,
                        yaw: this.player.yaw
                    }));
                } catch {}
            }
        } catch (e) {
            console.error('Animation error:', e);
        }
    };
}

// Start game when page loads
window.addEventListener('load', () => {
    console.log('Window load event fired');
    console.log('THREE available:', typeof THREE !== 'undefined');
    console.log('SimplexNoise available:', typeof SimplexNoise !== 'undefined');

    if (location.protocol === 'file:') {
        console.warn('Running from file:// — browser will block loading local resources (textures, audio). Start a simple local HTTP server to avoid CORS issues (example: `python -m http.server`).');
    }

    // Create menu music
    const menuMusic = new Audio('Posey.ogg');
    menuMusic.loop = true;
    menuMusic.volume = 0.5;
    
    // Create UI click sound
    const clickSound = new Audio('ui-click.mp3');
    clickSound.volume = 0.3;
    
    // Helper function to play click sound
    const playClickSound = () => {
        clickSound.currentTime = 0;
        clickSound.play().catch(e => console.log('Click sound failed:', e));
    };

    const stopMenuMusic = () => {
        if (!menuMusic) return;
        menuMusic.pause();
        menuMusic.currentTime = 0;
    };
    
    // Try autoplay first
    menuMusic.play().catch(e => {
        console.log('Audio autoplay blocked:', e);
        // Start music on first user interaction
        const startMusic = () => {
            menuMusic.play().catch(err => console.log('Music play failed:', err));
            document.removeEventListener('click', startMusic);
            document.removeEventListener('keydown', startMusic);
        };
        document.addEventListener('click', startMusic);
        document.addEventListener('keydown', startMusic);
    });

    // Create background scene with terrain and spinning camera
    console.log('Creating menu background scene...');
    document.body.style.background = 'transparent';
    const menuScene = new THREE.Scene();
    menuScene.background = new THREE.Color(0x4488ff); // Bright blue to confirm it's working
    menuScene.fog = new THREE.Fog(0x4488ff, 50, 150);
    const menuCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const menuRenderer = new THREE.WebGLRenderer({ antialias: true });
    menuRenderer.setSize(window.innerWidth, window.innerHeight);
    menuRenderer.domElement.style.position = 'fixed';
    menuRenderer.domElement.style.top = '0';
    menuRenderer.domElement.style.left = '0';
    menuRenderer.domElement.style.zIndex = '1';
    document.body.insertBefore(menuRenderer.domElement, document.body.firstChild);
    console.log('Menu renderer created');

    // Main-menu background: a single repeated stone texture surface.
    const menuTextureLoader = new THREE.TextureLoader();
    const menuStoneTexture = menuTextureLoader.load('stone.png');
    menuStoneTexture.wrapS = THREE.RepeatWrapping;
    menuStoneTexture.wrapT = THREE.RepeatWrapping;
    menuStoneTexture.repeat.set(56, 56);
    menuStoneTexture.anisotropy = 1;

    const menuStoneMat = new THREE.MeshLambertMaterial({
        map: menuStoneTexture,
        color: 0xffffff,
        side: THREE.DoubleSide
    });

    const menuFloor = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), menuStoneMat);
    menuFloor.rotation.x = -Math.PI / 2;
    menuFloor.position.y = 24;
    menuScene.add(menuFloor);

    // Add lighting
    const menuAmbient = new THREE.AmbientLight(0xffffff, 0.6);
    menuScene.add(menuAmbient);
    const menuDirectional = new THREE.DirectionalLight(0xffffff, 0.8);
    menuDirectional.position.set(1, 1, 0.5);
    menuScene.add(menuDirectional);

    // Top-down view
    menuCamera.position.set(0, 90, 0);
    menuCamera.lookAt(0, 24, 0);
    
    console.log('Menu scene setup complete. Scene children:', menuScene.children.length);

    // Keep main-menu background static (no camera spin).
    const menuAnimate = () => {
        if (!document.getElementById('main-menu')) {
            // Menu closed, stop animation and cleanup
            document.body.removeChild(menuRenderer.domElement);
            return;
        }

        menuRenderer.render(menuScene, menuCamera);
        requestAnimationFrame(menuAnimate);
    };

    // Handle window resize
    const menuResizeHandler = () => {
        menuCamera.aspect = window.innerWidth / window.innerHeight;
        menuCamera.updateProjectionMatrix();
        menuRenderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', menuResizeHandler);

    // Inject blocky pixel font
    if (!document.getElementById('agmora-font-link')) {
        const fontLink = document.createElement('link');
        fontLink.id = 'agmora-font-link';
        fontLink.rel = 'stylesheet';
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap';
        document.head.appendChild(fontLink);
    }

    // Show main menu to select world type
    const menu = document.createElement('div');
    menu.id = 'main-menu';
    menu.style.position = 'absolute';
    menu.style.left = '50%';
    menu.style.top = '50%';
    menu.style.transform = 'translate(-50%, -50%)';
    menu.style.background = 'transparent';
    menu.style.padding = '0';
    menu.style.border = 'none';
    menu.style.zIndex = '200';
    menu.style.textAlign = 'center';
    menu.style.display = 'flex';
    menu.style.flexDirection = 'column';
    menu.style.alignItems = 'center';
    menu.style.gap = '18px';

    // Title box — its own panel above the buttons
    const titleBox = document.createElement('div');
    titleBox.style.backgroundImage = 'url(sand.png)';
    titleBox.style.backgroundRepeat = 'repeat';
    titleBox.style.backgroundSize = '32px 32px';
    titleBox.style.backgroundColor = 'rgba(0,0,0,0.45)';
    titleBox.style.backgroundBlendMode = 'multiply';
    titleBox.style.border = '3px solid #c8a96e';
    titleBox.style.borderRadius = '6px';
    titleBox.style.padding = '22px 48px';
    titleBox.style.boxShadow = '0 4px 24px rgba(0,0,0,0.7)';

    const title = document.createElement('h1');
    title.id = 'menu-title';
    title.textContent = 'Agmora';
    title.style.color = '#fff';
    title.style.fontSize = '52px';
    title.style.letterSpacing = '4px';
    title.style.margin = '0';
    title.style.fontFamily = '"Press Start 2P", monospace';
    title.style.textShadow = '4px 4px 0px #333, 0 0 20px rgba(255,255,255,0.15)';
    title.style.imageRendering = 'pixelated';
    titleBox.appendChild(title);
    menu.appendChild(titleBox);

    // Main menu container (initially visible) — its own box below the title
    const mainMenuContainer = document.createElement('div');
    mainMenuContainer.id = 'main-menu-container';
    mainMenuContainer.style.backgroundImage = 'url(sand.png)';
    mainMenuContainer.style.backgroundRepeat = 'repeat';
    mainMenuContainer.style.backgroundSize = '32px 32px';
    mainMenuContainer.style.backgroundColor = 'rgba(0,0,0,0.45)';
    mainMenuContainer.style.backgroundBlendMode = 'multiply';
    mainMenuContainer.style.border = '3px solid #c8a96e';
    mainMenuContainer.style.borderRadius = '6px';
    mainMenuContainer.style.padding = '20px 40px';
    mainMenuContainer.style.boxShadow = '0 4px 24px rgba(0,0,0,0.7)';
    
    // Play Game button
    const playBtn = document.createElement('button');
    playBtn.textContent = 'Play Game';
    playBtn.style.width = '250px';
    playBtn.style.margin = '12px auto';
    playBtn.style.padding = '15px';
    playBtn.style.fontSize = '20px';
    playBtn.style.background = '#00cc00';
    playBtn.style.color = '#fff';
    playBtn.style.border = 'none';
    playBtn.style.borderRadius = '8px';
    playBtn.style.cursor = 'pointer';
    playBtn.style.display = 'block';
    playBtn.addEventListener('click', () => {
        playClickSound();
        mainMenuContainer.style.display = 'none';
        settingsContainer.style.display = 'block';
    });
    mainMenuContainer.appendChild(playBtn);

    // Host Game button (quick host instructions)
    const hostMenuBtn = document.createElement('button');
    hostMenuBtn.textContent = 'Host Game WIP';
    hostMenuBtn.style.width = '250px';
    hostMenuBtn.style.margin = '12px auto';
    hostMenuBtn.style.padding = '15px';
    hostMenuBtn.style.fontSize = '20px';
    hostMenuBtn.style.background = '#ffaa00';
    hostMenuBtn.style.color = '#000';
    hostMenuBtn.style.border = 'none';
    hostMenuBtn.style.borderRadius = '8px';
    hostMenuBtn.style.cursor = 'pointer';
    hostMenuBtn.style.display = 'block';
    hostMenuBtn.addEventListener('click', () => {
        const pw = prompt('Enter a password for your server (leave blank for none):') || '';
        localStorage.setItem('serverPassword', pw);
        alert(`To host a game, run the Node server on your machine with the same password.\n` +
              `Example:\nnode server.js 3000 0.0.0.0 ${pw || '<no password>'}\n` +
              `Then have your friend connect using that IP/port and password.`);
    });
    mainMenuContainer.appendChild(hostMenuBtn);
    
    // Settings button
    const settingsBtn = document.createElement('button');
    settingsBtn.textContent = 'Settings';
    settingsBtn.style.width = '250px';
    settingsBtn.style.margin = '12px auto';
    settingsBtn.style.padding = '15px';
    settingsBtn.style.fontSize = '20px';
    settingsBtn.style.background = '#666';
    settingsBtn.style.color = '#fff';
    settingsBtn.style.border = 'none';
    settingsBtn.style.borderRadius = '8px';
    settingsBtn.style.cursor = 'pointer';
    settingsBtn.style.display = 'block';
    settingsBtn.addEventListener('click', () => {
        playClickSound();
        mainMenuContainer.style.display = 'none';
        settingsOnlyContainer.style.display = 'block';
    });
    mainMenuContainer.appendChild(settingsBtn);
    
    menu.appendChild(mainMenuContainer);

    // Settings container (initially hidden)
    const settingsContainer = document.createElement('div');
    settingsContainer.id = 'settings-container';
    settingsContainer.style.display = 'none';

    // Player name input
    const nameRow = document.createElement('div');
    nameRow.style.margin = '8px 0';
    const nameLabel = document.createElement('label');
    nameLabel.style.color = '#fff';
    nameLabel.textContent = 'Player Name: ';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'player-name-input';
    nameInput.placeholder = 'Enter your name';
    nameInput.value = localStorage.getItem('playerName') || 'Player';
    nameInput.style.padding = '4px';
    nameInput.style.marginLeft = '4px';
    nameLabel.appendChild(nameInput);
    nameRow.appendChild(nameLabel);
    settingsContainer.appendChild(nameRow);

    // Player email input (hidden by default, shows on click)
    const emailRow = document.createElement('div');
    emailRow.id = 'email-row';
    emailRow.style.margin = '8px 0';
    emailRow.style.display = 'none'; // Hidden by default
    const emailLabel = document.createElement('label');
    emailLabel.style.color = '#fff';
    emailLabel.textContent = 'Email: ';
    const emailInput = document.createElement('input');
    emailInput.type = 'password';
    emailInput.id = 'player-email-input';
    emailInput.placeholder = 'Enter your email';
    emailInput.value = localStorage.getItem('playerEmail') || '';
    emailInput.style.padding = '4px';
    emailInput.style.marginLeft = '4px';
    emailLabel.appendChild(emailInput);
    emailRow.appendChild(emailLabel);
    settingsContainer.appendChild(emailRow);

    // Email toggle button
    const emailToggleBtn = document.createElement('button');
    emailToggleBtn.textContent = 'Add Email';
    emailToggleBtn.style.margin = '8px';
    emailToggleBtn.style.padding = '6px 12px';
    emailToggleBtn.style.fontSize = '12px';
    emailToggleBtn.style.background = '#444';
    emailToggleBtn.style.color = '#fff';
    emailToggleBtn.style.border = 'none';
    emailToggleBtn.style.borderRadius = '4px';
    emailToggleBtn.style.cursor = 'pointer';
    emailToggleBtn.addEventListener('click', () => {
        const emailRow = document.getElementById('email-row');
        const emailInput = document.getElementById('player-email-input');
        if (emailRow.style.display === 'none') {
            emailRow.style.display = 'block';
            emailInput.type = 'password';
            emailToggleBtn.textContent = 'Show Email';
        } else {
            if (emailInput.type === 'password') {
                emailInput.type = 'email';
                emailToggleBtn.textContent = 'Hide Email';
            } else {
                emailInput.type = 'password';
                emailToggleBtn.textContent = 'Show Email';
            }
        }
    });
    settingsContainer.insertBefore(emailToggleBtn, settingsContainer.children[2]); // Insert after name input

    const makeButton = (label, type) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.margin = '8px';
        b.style.padding = '8px 16px';
        b.style.fontSize = '14px';
        b.addEventListener('click', () => {
            playClickSound();
            startGame(type);
        });
        return b;
    };

    // Player customizer section
    const customizerRow = document.createElement('div');
    customizerRow.style.margin = '16px 0';
    customizerRow.style.padding = '12px';
    customizerRow.style.background = 'rgba(50,50,50,0.5)';
    customizerRow.style.borderRadius = '4px';
    customizerRow.style.border = '1px solid #555';
    
    const customizerTitle = document.createElement('div');
    customizerTitle.textContent = 'Player Customization';
    customizerTitle.style.color = '#fff';
    customizerTitle.style.fontWeight = 'bold';
    customizerTitle.style.marginBottom = '12px';
    customizerRow.appendChild(customizerTitle);
    
    // Player color picker
    const colorRow = document.createElement('div');
    colorRow.style.margin = '8px 0';
    colorRow.style.display = 'flex';
    colorRow.style.alignItems = 'center';
    colorRow.style.justifyContent = 'center';
    
    const colorLabel = document.createElement('label');
    colorLabel.style.color = '#aaa';
    colorLabel.style.marginRight = '10px';
    colorLabel.textContent = 'Player Color:';
    colorRow.appendChild(colorLabel);
    
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.id = 'player-color-picker';
    colorPicker.value = localStorage.getItem('playerColor') || '#4488ff';
    colorPicker.style.width = '60px';
    colorPicker.style.height = '30px';
    colorPicker.style.cursor = 'pointer';
    colorPicker.style.border = 'none';
    colorPicker.style.borderRadius = '4px';
    colorRow.appendChild(colorPicker);
    
    customizerRow.appendChild(colorRow);
    settingsContainer.appendChild(customizerRow);

    // Survival is now the default mode; creative can be enabled in chat with `cm.

    // Online server section
    const serverLabel = document.createElement('label');
    serverLabel.style.color = '#fff';
    serverLabel.style.display = 'block';
    serverLabel.style.margin = '12px 0 8px 0';
    const serverCheckbox = document.createElement('input');
    serverCheckbox.type = 'checkbox';
    serverCheckbox.id = 'server-enabled-checkbox';
    serverLabel.appendChild(serverCheckbox);
    serverLabel.appendChild(document.createTextNode(' Connect to Online Server'));
    settingsContainer.appendChild(serverLabel);

    // Server host input
    const hostRow = document.createElement('div');
    hostRow.style.margin = '8px 0';
    hostRow.style.display = 'none';
    hostRow.id = 'server-host-row';
    const hostLabel = document.createElement('label');
    hostLabel.style.color = '#aaa';
    hostLabel.textContent = 'Server Host: ';
    const hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.id = 'menu-server-host';
    hostInput.placeholder = 'localhost';
    hostInput.value = localStorage.getItem('serverHost') || 'localhost';
    hostInput.style.padding = '4px';
    hostInput.style.marginLeft = '4px';
    hostInput.style.width = '150px';
    hostLabel.appendChild(hostInput);
    hostRow.appendChild(hostLabel);
    settingsContainer.appendChild(hostRow);

    // Server port input
    const portRow = document.createElement('div');
    portRow.style.margin = '8px 0';
    portRow.style.display = 'none';
    portRow.id = 'server-port-row';
    const portLabel = document.createElement('label');
    portLabel.style.color = '#aaa';
    portLabel.textContent = 'Server Port: ';
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.id = 'menu-server-port';
    portInput.placeholder = '8080';
    portInput.value = localStorage.getItem('serverPort') || '8080';
    portInput.style.padding = '4px';
    portInput.style.marginLeft = '4px';
    portInput.style.width = '100px';
    portLabel.appendChild(portInput);
    portRow.appendChild(portLabel);
    settingsContainer.appendChild(portRow);

    // Server password input
    const passwordRow = document.createElement('div');
    passwordRow.style.margin = '8px 0';
    passwordRow.style.display = 'none';
    passwordRow.id = 'server-password-row';
    const passwordLabel = document.createElement('label');
    passwordLabel.style.color = '#aaa';
    passwordLabel.textContent = 'Password: ';
    const passwordInput = document.createElement('input');
    passwordInput.type = 'text';
    passwordInput.id = 'menu-server-password';
    passwordInput.placeholder = '(optional)';
    passwordInput.value = localStorage.getItem('serverPassword') || '';
    passwordInput.style.padding = '4px';
    passwordInput.style.marginLeft = '4px';
    passwordInput.style.width = '150px';
    passwordLabel.appendChild(passwordInput);
    passwordRow.appendChild(passwordLabel);
    settingsContainer.appendChild(passwordRow);

    // Toggle server fields visibility
    serverCheckbox.addEventListener('change', () => {
        const hostRow = document.getElementById('server-host-row');
        const portRow = document.getElementById('server-port-row');
        const pwdRow = document.getElementById('server-password-row');
        const savedRow = document.getElementById('saved-servers-row');
        if (serverCheckbox.checked) {
            hostRow.style.display = 'block';
            portRow.style.display = 'block';
            pwdRow.style.display = 'block';
            savedRow.style.display = 'block';
        } else {
            hostRow.style.display = 'none';
            portRow.style.display = 'none';
            pwdRow.style.display = 'none';
            savedRow.style.display = 'none';
        }
    });

    // Saved servers section
    const savedRow = document.createElement('div');
    savedRow.id = 'saved-servers-row';
    savedRow.style.margin = '12px 0';
    savedRow.style.display = 'none';
    savedRow.style.borderTop = '1px solid #555';
    savedRow.style.paddingTop = '8px';
    
    const savedLabel = document.createElement('div');
    savedLabel.style.color = '#aaa';
    savedLabel.style.fontSize = '12px';
    savedLabel.textContent = 'Saved Servers:';
    savedRow.appendChild(savedLabel);

    // Load saved servers from localStorage
    let savedServers = [];
    try {
        const stored = localStorage.getItem('savedServers');
        if (stored) savedServers = JSON.parse(stored);
    } catch (e) {}

    // Display saved servers
    const serverList = document.createElement('div');
    serverList.id = 'server-list';
    serverList.style.marginTop = '8px';
    
    function renderSavedServers() {
        serverList.innerHTML = '';
        if (savedServers.length === 0) {
            const empty = document.createElement('div');
            empty.style.color = '#666';
            empty.style.fontSize = '11px';
            empty.textContent = '(none saved)';
            serverList.appendChild(empty);
        } else {
            savedServers.forEach((server, idx) => {
                const serverDiv = document.createElement('div');
                serverDiv.style.background = 'rgba(0,0,0,0.5)';
                serverDiv.style.padding = '6px';
                serverDiv.style.margin = '4px 0';
                serverDiv.style.borderRadius = '3px';
                serverDiv.style.display = 'flex';
                serverDiv.style.justifyContent = 'space-between';
                serverDiv.style.alignItems = 'center';
                
                const info = document.createElement('span');
                info.style.color = '#aaa';
                info.style.fontSize = '11px';
                // display name + show a lock icon if password is set
                info.textContent = `${server.name || server.host}:${server.port}` + (server.password ? ' (pw)' : '');
                serverDiv.appendChild(info);
                
                const useBtn = document.createElement('button');
                useBtn.textContent = 'Use';
                useBtn.style.padding = '2px 8px';
                useBtn.style.margin = '0 4px';
                useBtn.style.fontSize = '10px';
                useBtn.style.background = '#0066cc';
                useBtn.style.color = '#fff';
                useBtn.style.border = 'none';
                useBtn.style.borderRadius = '3px';
                useBtn.style.cursor = 'pointer';
                useBtn.addEventListener('click', () => {
                    document.getElementById('menu-server-host').value = server.host;
                    document.getElementById('menu-server-port').value = server.port;
                    document.getElementById('menu-server-password').value = server.password || '';
                });
                serverDiv.appendChild(useBtn);

                // Join button - quick connect
                const joinBtn = document.createElement('button');
                joinBtn.textContent = 'Join';
                joinBtn.style.padding = '2px 8px';
                joinBtn.style.margin = '0 2px';
                joinBtn.style.fontSize = '10px';
                joinBtn.style.background = '#00aa00';
                joinBtn.style.color = '#fff';
                joinBtn.style.border = 'none';
                joinBtn.style.borderRadius = '3px';
                joinBtn.style.cursor = 'pointer';
                joinBtn.addEventListener('click', () => {
                    // Start game and connect to this server
                    const playerName = document.getElementById('player-name-input').value || 'Player';
                    const playerEmail = document.getElementById('player-email-input').value || '';
                    const pw = server.password || '';
                    localStorage.setItem('playerName', playerName);
                    localStorage.setItem('playerEmail', playerEmail);
                    localStorage.setItem('serverHost', server.host);
                    localStorage.setItem('serverPort', server.port);
                    localStorage.setItem('serverPassword', pw);
                    stopMenuMusic();
                    document.body.removeChild(menu);
                    const game = new Game('default', false, 'red', playerName);
                    window._game = game;
                    game.forceUnlockAudio();
                    game.connectServer(server.host, server.port, pw);
                });
                serverDiv.appendChild(joinBtn);
                
                const delBtn = document.createElement('button');
                delBtn.textContent = 'X';
                delBtn.style.padding = '2px 6px';
                delBtn.style.fontSize = '10px';
                delBtn.style.background = '#cc0000';
                delBtn.style.color = '#fff';
                delBtn.style.border = 'none';
                delBtn.style.borderRadius = '3px';
                delBtn.style.cursor = 'pointer';
                delBtn.addEventListener('click', () => {
                    savedServers.splice(idx, 1);
                    localStorage.setItem('savedServers', JSON.stringify(savedServers));
                    renderSavedServers();
                });
                serverDiv.appendChild(delBtn);
                
                serverList.appendChild(serverDiv);
            });
        }
    }
    
    renderSavedServers();
    savedRow.appendChild(serverList);

    // Button container for Save and Join
    const btnContainer = document.createElement('div');
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '8px';
    btnContainer.style.marginTop = '8px';

    // Add/Save button
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Server';
    saveBtn.style.flex = '1';
    saveBtn.style.padding = '6px';
    saveBtn.style.background = '#0066cc';
    saveBtn.style.color = '#fff';
    saveBtn.style.border = 'none';
    saveBtn.style.borderRadius = '3px';
    saveBtn.style.cursor = 'pointer';
    saveBtn.addEventListener('click', () => {
        const host = document.getElementById('menu-server-host').value || 'localhost';
        const port = parseInt(document.getElementById('menu-server-port').value, 10) || 8080;
        const pw = document.getElementById('menu-server-password').value || '';
        const name = `${host}:${port}` + (pw ? ' (pw)' : '');
        
        // Check if already saved
        const exists = savedServers.some(s => s.host === host && s.port === port && s.password === pw);
        if (!exists) {
            savedServers.push({ name, host, port, password: pw });
            localStorage.setItem('savedServers', JSON.stringify(savedServers));
            renderSavedServers();
        }
    });
    btnContainer.appendChild(saveBtn);

    // Join button - quick connect to current server
    const joinServerBtn = document.createElement('button');
    joinServerBtn.textContent = 'Join Server';
    joinServerBtn.style.flex = '1';
    joinServerBtn.style.padding = '6px';
    joinServerBtn.style.background = '#00aa00';
    joinServerBtn.style.color = '#fff';
    joinServerBtn.style.border = 'none';
    joinServerBtn.style.borderRadius = '3px';
    joinServerBtn.style.cursor = 'pointer';
    joinServerBtn.addEventListener('click', () => {
        // Start game and connect to this server
        const host = document.getElementById('menu-server-host').value || 'localhost';
        const port = parseInt(document.getElementById('menu-server-port').value, 10) || 8080;
        const pw = document.getElementById('menu-server-password').value || '';
        const playerName = document.getElementById('player-name-input').value || 'Player';
        const playerEmail = document.getElementById('player-email-input').value || '';
        localStorage.setItem('playerName', playerName);
        localStorage.setItem('playerEmail', playerEmail);
        localStorage.setItem('serverHost', host);
        localStorage.setItem('serverPort', port);
        localStorage.setItem('serverPassword', pw);
        stopMenuMusic();
        document.body.removeChild(menu);
        const game = new Game('default', false, 'red', playerName);
        window._game = game;
        game.forceUnlockAudio();
        game.connectServer(host, port, pw);
    });
    btnContainer.appendChild(joinServerBtn);

    // Host button will simply store a password and give instructions
    const hostBtn = document.createElement('button');
    hostBtn.textContent = 'Host';
    hostBtn.style.flex = '1';
    hostBtn.style.padding = '6px';
    hostBtn.style.background = '#ffaa00';
    hostBtn.style.color = '#000';
    hostBtn.style.border = 'none';
    hostBtn.style.borderRadius = '3px';
    hostBtn.style.cursor = 'pointer';
    hostBtn.addEventListener('click', () => {
        const pw = prompt('Enter a password for your server (leave blank for none):') || '';
        localStorage.setItem('serverPassword', pw);
        alert(`To host a game, run the Node server on your machine with the same password.\n` +
              `Example:\nnode server.js 3000 0.0.0.0 ${pw || '<no password>'}\n` +
              `Then have your friend connect using that IP/port and password.`);
    });
    btnContainer.appendChild(hostBtn);

    savedRow.appendChild(btnContainer);

    settingsContainer.appendChild(savedRow);

    // Start slots: click empty slot to create, click filled slot to load
    const slotTitle = document.createElement('h3');
    slotTitle.textContent = 'Choose Save Slot';
    slotTitle.style.color = '#fff';
    slotTitle.style.marginTop = '20px';
    settingsContainer.appendChild(slotTitle);

    const slotInfo = document.createElement('div');
    slotInfo.textContent = 'Empty = New Game, Filled = Load';
    slotInfo.style.color = '#bbb';
    slotInfo.style.fontSize = '12px';
    slotInfo.style.marginBottom = '10px';
    settingsContainer.appendChild(slotInfo);

    const slotGrid = document.createElement('div');
    slotGrid.style.display = 'grid';
    slotGrid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
    slotGrid.style.gap = '10px';
    slotGrid.style.maxWidth = '500px';
    slotGrid.style.margin = '0 auto';
    settingsContainer.appendChild(slotGrid);

    const getSaveForSlot = (slot) => {
        const key = `voxelWorldSave${slot}`;
        const legacyKey = slot === 1 ? 'voxelWorldSave' : null;
        const hasPrimary = !!localStorage.getItem(key);
        const raw = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
        if (!raw) return { key, legacyKey, data: null };
        try {
            const data = JSON.parse(raw);
            return { key: hasPrimary ? key : legacyKey, legacyKey, data };
        } catch (e) {
            return { key, legacyKey, data: null };
        }
    };

    const cleanupMenuBeforeGame = () => {
        stopMenuMusic();
        window.removeEventListener('resize', menuResizeHandler);
        if (document.body.contains(menu)) document.body.removeChild(menu);
        const musicCredit = document.getElementById('music-credit');
        if (musicCredit && document.body.contains(musicCredit)) document.body.removeChild(musicCredit);
        const gameCredit = document.getElementById('game-credit');
        if (gameCredit && document.body.contains(gameCredit)) document.body.removeChild(gameCredit);
    };

    const renderSlotGrid = () => {
        slotGrid.innerHTML = '';
        for (let slot = 1; slot <= 8; slot++) {
            const info = getSaveForSlot(slot);
            const card = document.createElement('button');
            card.type = 'button';
            card.style.position = 'relative';
            card.style.textAlign = 'left';
            card.style.padding = '12px';
            card.style.minHeight = '88px';
            card.style.background = 'rgba(0,0,0,0.45)';
            card.style.border = '1px solid #666';
            card.style.borderRadius = '8px';
            card.style.color = '#fff';
            card.style.cursor = 'pointer';

            const del = document.createElement('button');
            del.type = 'button';
            del.textContent = '🗑';
            del.title = `Delete Slot ${slot}`;
            del.style.position = 'absolute';
            del.style.top = '6px';
            del.style.right = '6px';
            del.style.width = '24px';
            del.style.height = '24px';
            del.style.lineHeight = '20px';
            del.style.padding = '0';
            del.style.border = '1px solid #a44';
            del.style.borderRadius = '6px';
            del.style.background = 'rgba(120,20,20,0.75)';
            del.style.color = '#fff';
            del.style.cursor = info.data ? 'pointer' : 'not-allowed';
            del.style.opacity = info.data ? '1' : '0.35';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!info.data) return;
                if (!confirm(`Delete save in Slot ${slot}?`)) return;
                localStorage.removeItem(`voxelWorldSave${slot}`);
                if (slot === 1) localStorage.removeItem('voxelWorldSave');
                renderSlotGrid();
            });
            card.appendChild(del);

            const label = document.createElement('div');
            label.textContent = `Slot ${slot}`;
            label.style.fontWeight = 'bold';
            label.style.marginBottom = '4px';
            card.appendChild(label);

            const meta = document.createElement('div');
            meta.style.fontSize = '12px';
            meta.style.color = '#ccc';
            if (info.data && info.data.timestamp) {
                const d = new Date(info.data.timestamp);
                meta.textContent = `Saved: ${d.toLocaleString()}`;
            } else {
                meta.textContent = 'Empty (New Game)';
            }
            card.appendChild(meta);

            card.addEventListener('click', () => {
                playClickSound();
                const slotInfoNow = getSaveForSlot(slot);
                if (slotInfoNow.data) {
                    cleanupMenuBeforeGame();
                    window.loadSavedWorld(slotInfoNow.key);
                } else {
                    localStorage.setItem('lastPlayedSlot', String(slot));
                    startGame('default');
                }
            });

            slotGrid.appendChild(card);
        }
    };

    renderSlotGrid();
    
    // Back button for Play Game screen
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.width = '150px';
    backBtn.style.margin = '20px auto';
    backBtn.style.padding = '10px';
    backBtn.style.fontSize = '14px';
    backBtn.style.background = '#666';
    backBtn.style.color = '#fff';
    backBtn.style.border = 'none';
    backBtn.style.borderRadius = '4px';
    backBtn.style.cursor = 'pointer';
    backBtn.style.display = 'block';
    backBtn.addEventListener('click', () => {
        playClickSound();
        settingsContainer.style.display = 'none';
        mainMenuContainer.style.display = 'block';
    });
    settingsContainer.appendChild(backBtn);
    
    menu.appendChild(settingsContainer);

    // Settings-only container (for the Settings button, initially hidden)
    const settingsOnlyContainer = document.createElement('div');
    settingsOnlyContainer.id = 'settings-only-container';
    settingsOnlyContainer.style.display = 'none';
    
    const settingsTitle = document.createElement('h3');
    settingsTitle.textContent = 'Settings';
    settingsTitle.style.color = '#fff';
    settingsTitle.style.marginBottom = '20px';
    settingsOnlyContainer.appendChild(settingsTitle);
    
    // FOV Slider
    const fovRow = document.createElement('div');
    fovRow.style.margin = '20px 0';
    fovRow.style.padding = '12px';
    fovRow.style.background = 'rgba(50,50,50,0.5)';
    fovRow.style.borderRadius = '4px';
    fovRow.style.border = '1px solid #555';
    
    const fovLabel = document.createElement('label');
    fovLabel.style.color = '#fff';
    fovLabel.style.display = 'block';
    fovLabel.style.marginBottom = '8px';
    const fovValue = document.createElement('span');
    fovValue.id = 'fov-value';
    fovValue.style.color = '#4488ff';
    fovValue.style.fontWeight = 'bold';
    const savedFov = localStorage.getItem('fov') || '90';
    fovValue.textContent = savedFov;
    fovLabel.appendChild(document.createTextNode('Field of View (FOV): '));
    fovLabel.appendChild(fovValue);
    fovRow.appendChild(fovLabel);
    
    const fovSlider = document.createElement('input');
    fovSlider.type = 'range';
    fovSlider.id = 'fov-slider';
    fovSlider.min = '90';
    fovSlider.max = '120';
    fovSlider.value = savedFov;
    fovSlider.style.width = '100%';
    fovSlider.style.cursor = 'pointer';
    fovSlider.addEventListener('input', (e) => {
        fovValue.textContent = e.target.value;
        localStorage.setItem('fov', e.target.value);
        // Apply to game if running
        if (window._game && window._game.camera) {
            const nextFov = parseFloat(e.target.value);
            window._game.camera.fov = nextFov;
            window._game.camera.updateProjectionMatrix();
            if (window._game.thirdCamera) {
                window._game.thirdCamera.fov = nextFov;
                window._game.thirdCamera.updateProjectionMatrix();
            }
        }
    });
    fovRow.appendChild(fovSlider);
    
    settingsOnlyContainer.appendChild(fovRow);

    // Render distance settings
    const renderDistanceRow = document.createElement('div');
    renderDistanceRow.style.margin = '20px 0';
    renderDistanceRow.style.padding = '12px';
    renderDistanceRow.style.background = 'rgba(50,50,50,0.5)';
    renderDistanceRow.style.borderRadius = '4px';
    renderDistanceRow.style.border = '1px solid #555';

    const renderDistanceLabel = document.createElement('label');
    renderDistanceLabel.style.color = '#fff';
    renderDistanceLabel.style.display = 'block';
    renderDistanceLabel.style.marginBottom = '8px';
    const renderDistanceValue = document.createElement('span');
    renderDistanceValue.style.color = '#4488ff';
    renderDistanceValue.style.fontWeight = 'bold';
    const savedRenderDistance = Math.max(1, Math.min(8, Number(localStorage.getItem('renderDistance')) || 4));
    renderDistanceValue.textContent = String(savedRenderDistance);
    renderDistanceLabel.appendChild(document.createTextNode('Render Distance: '));
    renderDistanceLabel.appendChild(renderDistanceValue);
    renderDistanceRow.appendChild(renderDistanceLabel);

    const renderDistanceSlider = document.createElement('input');
    renderDistanceSlider.type = 'range';
    renderDistanceSlider.id = 'render-distance-slider';
    renderDistanceSlider.min = '1';
    renderDistanceSlider.max = '8';
    renderDistanceSlider.step = '1';
    renderDistanceSlider.value = String(savedRenderDistance);
    renderDistanceSlider.style.width = '100%';
    renderDistanceSlider.style.cursor = 'pointer';
    renderDistanceSlider.addEventListener('input', (e) => {
        const next = Math.max(1, Math.min(8, Number(e.target.value) || 4));
        renderDistanceValue.textContent = String(next);
        localStorage.setItem('renderDistance', String(next));
        if (window._game && typeof window._game.setRenderDistance === 'function') {
            window._game.setRenderDistance(next);
        }
    });
    renderDistanceRow.appendChild(renderDistanceSlider);

    const renderDistanceHint = document.createElement('div');
    renderDistanceHint.textContent = 'Lower = better performance, higher = see farther';
    renderDistanceHint.style.color = '#bbb';
    renderDistanceHint.style.fontSize = '12px';
    renderDistanceHint.style.marginTop = '6px';
    renderDistanceRow.appendChild(renderDistanceHint);

    settingsOnlyContainer.appendChild(renderDistanceRow);

    // Camera Bob toggle
    const bobRow = document.createElement('div');
    bobRow.style.margin = '12px 0';
    bobRow.style.padding = '12px';
    bobRow.style.background = 'rgba(50,50,50,0.5)';
    bobRow.style.borderRadius = '4px';
    bobRow.style.border = '1px solid #555';

    const savedCameraBob = localStorage.getItem('cameraBobEnabled');
    const cameraBobEnabled = savedCameraBob === null ? true : savedCameraBob !== 'false';

    const bobLabel = document.createElement('label');
    bobLabel.style.color = '#fff';
    bobLabel.style.display = 'flex';
    bobLabel.style.alignItems = 'center';
    bobLabel.style.justifyContent = 'space-between';
    bobLabel.style.cursor = 'pointer';
    bobLabel.textContent = 'Camera Bob';

    const bobToggle = document.createElement('input');
    bobToggle.type = 'checkbox';
    bobToggle.id = 'camera-bob-checkbox';
    bobToggle.checked = cameraBobEnabled;
    bobToggle.addEventListener('change', () => {
        localStorage.setItem('cameraBobEnabled', bobToggle.checked ? 'true' : 'false');
    });

    bobLabel.appendChild(bobToggle);
    bobRow.appendChild(bobLabel);
    settingsOnlyContainer.appendChild(bobRow);

    // Fog settings
    const fogRow = document.createElement('div');
    fogRow.style.margin = '20px 0';
    fogRow.style.padding = '12px';
    fogRow.style.background = 'rgba(50,50,50,0.5)';
    fogRow.style.borderRadius = '4px';
    fogRow.style.border = '1px solid #555';

    const savedFogEnabled = localStorage.getItem('fogEnabled');
    const fogEnabled = savedFogEnabled === null ? true : savedFogEnabled !== 'false';
    const savedFogDensity = localStorage.getItem('fogDensity');
    const fogDensity = savedFogDensity !== null ? Math.min(Math.max(parseFloat(savedFogDensity), 0.0), 0.05) : 0.01;

    const fogHeader = document.createElement('div');
    fogHeader.style.display = 'flex';
    fogHeader.style.alignItems = 'center';
    fogHeader.style.justifyContent = 'space-between';
    fogHeader.style.marginBottom = '8px';

    const fogLabel = document.createElement('label');
    fogLabel.style.color = '#fff';
    fogLabel.appendChild(document.createTextNode('Fog Enabled'));

    const fogEnabledCheckbox = document.createElement('input');
    fogEnabledCheckbox.type = 'checkbox';
    fogEnabledCheckbox.id = 'fog-enabled-checkbox';
    fogEnabledCheckbox.checked = fogEnabled;
    fogLabel.appendChild(fogEnabledCheckbox);
    fogHeader.appendChild(fogLabel);

    const fogValue = document.createElement('span');
    fogValue.id = 'fog-distance-value';
    fogValue.style.color = '#4488ff';
    fogValue.style.fontWeight = 'bold';
    fogValue.textContent = fogDensity.toFixed(3);
    fogHeader.appendChild(fogValue);

    fogRow.appendChild(fogHeader);

    const fogSlider = document.createElement('input');
    fogSlider.type = 'range';
    fogSlider.id = 'fog-distance-slider';
    fogSlider.min = '0.0';
    fogSlider.max = '0.05';
    fogSlider.step = '0.001';
    fogSlider.value = fogDensity;
    fogSlider.style.width = '100%';
    fogSlider.style.cursor = 'pointer';

    const applyFogSettings = (enabled, densityValue) => {
        const d = Math.min(Math.max(densityValue, 0.0), 0.05);
        if (window._game && window._game.scene) {
            window._game.scene.fog = enabled ? new THREE.FogExp2(0x87CEEB, d) : null;
        }
    };

    fogEnabledCheckbox.addEventListener('change', () => {
        localStorage.setItem('fogEnabled', fogEnabledCheckbox.checked);
        applyFogSettings(fogEnabledCheckbox.checked, parseFloat(fogSlider.value));
    });

    fogSlider.addEventListener('input', (e) => {
        const d = parseFloat(e.target.value);
        fogValue.textContent = d.toFixed(3);
        localStorage.setItem('fogDensity', Math.min(Math.max(d, 0.0), 0.05));
        applyFogSettings(fogEnabledCheckbox.checked, d);
    });

    fogRow.appendChild(fogSlider);
    settingsOnlyContainer.appendChild(fogRow);
    
    const settingsInfo = document.createElement('p');
    settingsInfo.textContent = 'Adjust FOV to change your view angle.';
    settingsInfo.style.color = '#aaa';
    settingsInfo.style.margin = '20px 0';
    settingsInfo.style.fontSize = '12px';
    settingsOnlyContainer.appendChild(settingsInfo);
    
    // Back button for settings-only
    const backBtn2 = document.createElement('button');
    backBtn2.textContent = 'Back';
    backBtn2.style.width = '150px';
    backBtn2.style.margin = '20px auto';
    backBtn2.style.padding = '10px';
    backBtn2.style.fontSize = '14px';
    backBtn2.style.background = '#666';
    backBtn2.style.color = '#fff';
    backBtn2.style.border = 'none';
    backBtn2.style.borderRadius = '4px';
    backBtn2.style.cursor = 'pointer';
    backBtn2.style.display = 'block';
    backBtn2.addEventListener('click', () => {
        playClickSound();
        settingsOnlyContainer.style.display = 'none';
        mainMenuContainer.style.display = 'block';
    });
    settingsOnlyContainer.appendChild(backBtn2);
    
    menu.appendChild(settingsOnlyContainer);

    document.body.appendChild(menu);
    
    // Music credit box (separate, top-right)
    const musicCredit = document.createElement('div');
    musicCredit.id = 'music-credit';
    musicCredit.textContent = 'music by iverstim';
    musicCredit.style.position = 'fixed';
    musicCredit.style.top = '20px';
    musicCredit.style.right = '20px';
    musicCredit.style.background = 'rgba(0,0,0,0.8)';
    musicCredit.style.color = '#aa44ff';
    musicCredit.style.padding = '10px 15px';
    musicCredit.style.borderRadius = '6px';
    musicCredit.style.border = '2px solid #aa44ff';
    musicCredit.style.fontSize = '14px';
    musicCredit.style.fontStyle = 'italic';
    musicCredit.style.zIndex = '250';
    musicCredit.style.textShadow = '1px 1px 2px rgba(0,0,0,0.5)';
    document.body.appendChild(musicCredit);
    
    // Game credit box (below music credit)
    const gameCredit = document.createElement('div');
    gameCredit.id = 'game-credit';
    gameCredit.textContent = 'game code by agare';
    gameCredit.style.position = 'fixed';
    gameCredit.style.top = '80px';
    gameCredit.style.right = '20px';
    gameCredit.style.background = 'rgba(0,0,0,0.8)';
    gameCredit.style.color = '#b80d0dff';
    gameCredit.style.padding = '10px 15px';
    gameCredit.style.borderRadius = '6px';
    gameCredit.style.border = '2px solid #fc0404ff';
    gameCredit.style.fontSize = '14px';
    gameCredit.style.fontStyle = 'italic';
    gameCredit.style.zIndex = '250';
    gameCredit.style.textShadow = '1px 1px 2px rgba(0,0,0,0.5)';
    document.body.appendChild(gameCredit);
    
    console.log('Main menu created and appended to body');
    
    // Start menu animation now that menu exists
    menuAnimate();
    console.log('Menu animation started');

    // Show load world menu
    window.showLoadWorldMenu = (mainMenu) => {
        const loadMenu = document.createElement('div');
        loadMenu.style.position = 'absolute';
        loadMenu.style.top = '50%';
        loadMenu.style.left = '50%';
        loadMenu.style.transform = 'translate(-50%, -50%)';
        loadMenu.style.background = 'rgba(0,0,0,0.95)';
        loadMenu.style.padding = '24px';
        loadMenu.style.borderRadius = '8px';
        loadMenu.style.border = '2px solid #666';
        loadMenu.style.minWidth = '400px';
        loadMenu.style.maxWidth = '600px';
        loadMenu.style.maxHeight = '80vh';
        loadMenu.style.overflowY = 'auto';
        loadMenu.style.zIndex = '1000';

        const title = document.createElement('h2');
        title.textContent = 'Load World';
        title.style.color = '#fff';
        title.style.marginBottom = '16px';
        title.style.textAlign = 'center';
        loadMenu.appendChild(title);

        // Get saved worlds from localStorage (8 slots, with legacy fallback for slot 1)
        const savedWorlds = [];
        try {
            for (let slot = 1; slot <= 8; slot++) {
                const key = `voxelWorldSave${slot}`;
                const legacyKey = slot === 1 ? 'voxelWorldSave' : null;
                const saveData = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
                if (!saveData) continue;

                const parsed = JSON.parse(saveData);
                savedWorlds.push({
                    name: `Slot ${slot}`,
                    data: parsed,
                    key: localStorage.getItem(key) ? key : legacyKey
                });
            }
        } catch (e) {
            console.error('Failed to load saved worlds:', e);
        }

        if (savedWorlds.length === 0) {
            const noSaves = document.createElement('p');
            noSaves.textContent = 'No saved worlds found.';
            noSaves.style.color = '#aaa';
            noSaves.style.textAlign = 'center';
            noSaves.style.margin = '20px 0';
            loadMenu.appendChild(noSaves);
        } else {
            savedWorlds.forEach(world => {
                const worldDiv = document.createElement('div');
                worldDiv.style.background = 'rgba(255,255,255,0.05)';
                worldDiv.style.padding = '12px';
                worldDiv.style.margin = '8px 0';
                worldDiv.style.borderRadius = '6px';
                worldDiv.style.border = '1px solid #444';
                worldDiv.style.cursor = 'pointer';
                worldDiv.style.transition = 'all 0.2s';

                worldDiv.addEventListener('mouseenter', () => {
                    worldDiv.style.background = 'rgba(255,255,255,0.1)';
                    worldDiv.style.borderColor = '#888';
                });
                worldDiv.addEventListener('mouseleave', () => {
                    worldDiv.style.background = 'rgba(255,255,255,0.05)';
                    worldDiv.style.borderColor = '#444';
                });

                const nameEl = document.createElement('div');
                nameEl.textContent = world.name;
                nameEl.style.color = '#fff';
                nameEl.style.fontSize = '16px';
                nameEl.style.fontWeight = 'bold';
                nameEl.style.marginBottom = '4px';
                worldDiv.appendChild(nameEl);

                const infoEl = document.createElement('div');
                infoEl.style.color = '#aaa';
                infoEl.style.fontSize = '12px';
                const worldType = world.data.worldType || 'default';
                const posX = world.data.playerPosition?.x?.toFixed(0) || '0';
                const posY = world.data.playerPosition?.y?.toFixed(0) || '0';
                const posZ = world.data.playerPosition?.z?.toFixed(0) || '0';
                const chunkCount = Object.keys(world.data.chunks || {}).length;
                let timeStr = '';
                if (world.data.timestamp) {
                    const date = new Date(world.data.timestamp);
                    timeStr = `<br>Last saved: ${date.toLocaleString()}`;
                }
                infoEl.innerHTML = `Type: ${worldType}<br>Position: (${posX}, ${posY}, ${posZ})<br>Modified chunks: ${chunkCount}${timeStr}`;
                worldDiv.appendChild(infoEl);

                const btnContainer = document.createElement('div');
                btnContainer.style.display = 'flex';
                btnContainer.style.gap = '8px';
                btnContainer.style.marginTop = '8px';

                const loadWorldBtn = document.createElement('button');
                loadWorldBtn.textContent = 'Load';
                loadWorldBtn.style.flex = '1';
                loadWorldBtn.style.padding = '6px';
                loadWorldBtn.style.background = '#00aa00';
                loadWorldBtn.style.color = '#fff';
                loadWorldBtn.style.border = 'none';
                loadWorldBtn.style.borderRadius = '4px';
                loadWorldBtn.style.cursor = 'pointer';
                loadWorldBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    loadSavedWorld(world.key);
                    document.body.removeChild(loadMenu);
                    document.body.removeChild(mainMenu);
                });
                btnContainer.appendChild(loadWorldBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = 'Delete';
                deleteBtn.style.flex = '1';
                deleteBtn.style.padding = '6px';
                deleteBtn.style.background = '#cc0000';
                deleteBtn.style.color = '#fff';
                deleteBtn.style.border = 'none';
                deleteBtn.style.borderRadius = '4px';
                deleteBtn.style.cursor = 'pointer';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm('Are you sure you want to delete this save?')) {
                        localStorage.removeItem(world.key);
                        document.body.removeChild(loadMenu);
                        showLoadWorldMenu(mainMenu);
                    }
                });
                btnContainer.appendChild(deleteBtn);

                worldDiv.appendChild(btnContainer);
                loadMenu.appendChild(worldDiv);
            });
        }

        const backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.style.width = '100%';
        backBtn.style.margin = '16px 0 0 0';
        backBtn.style.padding = '10px';
        backBtn.style.background = '#666';
        backBtn.style.color = '#fff';
        backBtn.style.border = 'none';
        backBtn.style.borderRadius = '4px';
        backBtn.style.cursor = 'pointer';
        backBtn.addEventListener('click', () => {
            document.body.removeChild(loadMenu);
        });
        loadMenu.appendChild(backBtn);

        document.body.appendChild(loadMenu);
    };

    // Load saved world function
    window.loadSavedWorld = (saveKey) => {
        try {
            const hotbarUi = document.getElementById('ui');
            if (hotbarUi) hotbarUi.style.display = 'flex';
            const coordsHud = document.getElementById('coords-hud');
            if (coordsHud) coordsHud.style.display = 'flex';

            const saveData = localStorage.getItem(saveKey);
            if (!saveData) {
                alert('Save not found!');
                return;
            }

            stopMenuMusic();

            const data = JSON.parse(saveData);
            console.log('Loading saved world:', data);

            const playerName = document.getElementById('player-name-input')?.value || 'Player';
            localStorage.setItem('playerName', playerName);

            // Create game with saved world type and survival mode
            const survivalMode = data.survivalMode !== false;
            const game = new Game(data.worldType || 'default', false, 'red', playerName, survivalMode);
            window._game = game;
            game.forceUnlockAudio();

            // Restore player state
            if (data.playerPosition) {
                const loadedX = Number(data.playerPosition.x) || 0;
                const loadedZ = Number(data.playerPosition.z) || 0;
                const loadedY = Number(data.playerPosition.y) || 0;
                const surfaceY = game.world.getTerrainHeight(Math.floor(loadedX), Math.floor(loadedZ));
                const minSafeY = Math.min(game.world.chunkHeight - 3, surfaceY + 3);
                game.player.position.set(
                    loadedX,
                    Math.max(loadedY, minSafeY),
                    loadedZ
                );
            }
            if (data.playerYaw !== undefined) game.player.yaw = data.playerYaw;
            if (data.playerPitch !== undefined) game.player.pitch = data.playerPitch;
            if (data.inventory) game.player.inventory = data.inventory;
            if (data.equipment) game.player.equipment = { tool: 0, ...data.equipment };
            if (data.selectedBlock !== undefined) game.player.selectedBlock = data.selectedBlock;

            const hasLifeLoaded = game.player.hasAccessoryEquipped(game.LIFE_CONTANER_TYPE);
            const hasEnergyLoaded = game.player.hasAccessoryEquipped(game.ENERGY_VESSEIL_TYPE);
            const loadedMaxHealth = Math.max(10, Math.min(60, Number(data.playerMaxHealth) || 10));
            const loadedMaxAP = Math.max(5, Math.min(60, Number(data.playerMaxAP) || 5));

            const derivedBaseHp = loadedMaxHealth - (hasLifeLoaded ? 10 : 0);
            const derivedBaseAp = loadedMaxAP - (hasEnergyLoaded ? 10 : 0);

            game.player.baseMaxHealth = Math.max(10, Math.min(50,
                Number(data.playerBaseMaxHealth) || derivedBaseHp || game.player.baseMaxHealth || 10
            ));
            game.player.baseMaxAP = Math.max(5, Math.min(50,
                Number(data.playerBaseMaxAP) || derivedBaseAp || game.player.baseMaxAP || 5
            ));

            game.applyContainerAccessoryBonuses();

            if (data.playerHealth !== undefined) game.player.health = Number(data.playerHealth) || game.player.maxHealth;
            game.player.health = Math.min(game.player.maxHealth, Math.max(0, game.player.health));
            if (data.playerAP !== undefined) game.player.ap = Number(data.playerAP) || game.player.maxAP;
            game.player.ap = Math.min(game.player.maxAP, Math.max(0, game.player.ap));
            game.player.gold = Math.max(0, Math.trunc(Number(data.playerGold) || 0));
            if (data.playerMaxMP !== undefined) game.player.maxMP = Math.max(3, Math.min(30, Number(data.playerMaxMP) || 3));
            if (data.playerMP !== undefined) game.player.mp = Number(data.playerMP) || game.player.maxMP;
            game.player.mp = Math.min(game.player.maxMP, Math.max(0, game.player.mp));
            if (data.playerLevel !== undefined) game.player.level = Math.max(1, Math.min(27, Number(data.playerLevel) || 1));
            if (data.playerXP !== undefined) game.player.xp = Math.max(0, Math.min(100, Number(data.playerXP) || 0));
            game.player.maxLevel = 27;
            game.player.xpToNext = 100;
            if (data.dayTime !== undefined) game.dayTime = data.dayTime;
            if (typeof data.weatherState === 'string') game.weatherState = data.weatherState;
            if (data.lastWeatherRollNight !== undefined) game.lastWeatherRollNight = Number(data.lastWeatherRollNight) || -1;
            if (data.hotbarIndex !== undefined) game.hotbarIndex = data.hotbarIndex;
            if (data.mapWaypoints) {
                game.mapWaypoints = {
                    default: Array.isArray(data.mapWaypoints.default) ? data.mapWaypoints.default : [],
                    fairia: Array.isArray(data.mapWaypoints.fairia) ? data.mapWaypoints.fairia : [],
                    astral: Array.isArray(data.mapWaypoints.astral) ? data.mapWaypoints.astral : []
                };
            }
            if (Array.isArray(data.woodDoors)) {
                game.woodDoors = data.woodDoors.map(d => game.recreateDoorMesh(d, game.WOOD_DOOR_TYPE));
            }
            if (Array.isArray(data.dungeonDoors)) {
                game.dungeonDoors = data.dungeonDoors.map(d => game.recreateDoorMesh(d, game.DUNGEON_DOOR_TYPE));
            }

            // Restore chest storage if present
            if (data.chestStorage) {
                game.chestStorage = new Map(Object.entries(data.chestStorage).map(([key, val]) => [key, val]));
            }
            if (data.lockedChests) {
                game.lockedChests = new Map(Object.entries(data.lockedChests).map(([key, val]) => [key, val]));
            } else {
                game.lockedChests = new Map();
            }
            game.cathedralLockedChestKey = data.cathedralLockedChestKey || null;
            if (data.cauldronStorage) {
                game.cauldronStorage = new Map(Object.entries(data.cauldronStorage).map(([key, val]) => [key, val]));
            }

            // Refresh UI after restoring player state
            game.updateInventoryUI();
            game.updateHotbar();
            game.updateHealthBar();
            game.updateAPBar();
            game.updateMPBar();
            game.updateXPBar();
            game.updateGoldDisplay();

            // Restore chunks
            if (data.chunks) {
                for (const [key, chunkData] of Object.entries(data.chunks)) {
                    const chunk = game.world.getChunk(chunkData.cx, chunkData.cz);
                    if (chunkData.blocks) {
                        // Decompress base64 if it's a string (new format), otherwise use array (old format)
                        if (typeof chunkData.blocks === 'string') {
                            const binaryString = atob(chunkData.blocks);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            chunk.blocks = bytes;
                        } else {
                            chunk.blocks = new Uint8Array(chunkData.blocks);
                        }
                        chunk.modified = true;
                        chunk.playerModified = true;
                    }
                    // Update mesh for this chunk
                    game.updateChunkMesh(chunkData.cx, chunkData.cz);
                }
                // If using runtime torch lights, rebuild them after load; otherwise lightmaps handle it
                if (game.useRuntimeTorchLights) {
                    try { game.rebuildTorchLights(); } catch {}
                }
            }

            console.log('World loaded successfully!');
        } catch (e) {
            console.error('Failed to load world:', e);
            alert('Failed to load world: ' + e.message);
        }
    };

    // Start the game with the selected world type (defaults to survival mode)
        window.startGame = (worldType = 'default') => {
        try {
            const hotbarUi = document.getElementById('ui');
            if (hotbarUi) hotbarUi.style.display = 'flex';
            const coordsHud = document.getElementById('coords-hud');
            if (coordsHud) coordsHud.style.display = 'flex';

            // Read values BEFORE removing menu from DOM
            const isMultiplayer = false;
            const team = 'red';
            const playerName = document.getElementById('player-name-input').value || 'Player';
            const playerEmail = document.getElementById('player-email-input').value || '';
            const playerColor = document.getElementById('player-color-picker').value || '#4488ff';
            const useServer = !!document.getElementById('server-enabled-checkbox').checked;
            const serverHost = document.getElementById('menu-server-host').value || 'localhost';
            const serverPort = parseInt(document.getElementById('menu-server-port').value, 10) || 8080;
            const serverPassword = document.getElementById('menu-server-password').value || '';
            const survivalMode = true;
            
            // Save to localStorage
            localStorage.setItem('playerName', playerName);
            localStorage.setItem('playerEmail', playerEmail);
            localStorage.setItem('playerColor', playerColor);
            localStorage.setItem('serverHost', serverHost);
            localStorage.setItem('serverPort', serverPort);
            localStorage.setItem('serverPassword', serverPassword);
            
            // Stop menu music
            stopMenuMusic();
            
            // Remove menu and cleanup background scene
            window.removeEventListener('resize', menuResizeHandler);
            document.body.removeChild(menu);
            
            // Remove music credit box
            const musicCredit = document.getElementById('music-credit');
            if (musicCredit) document.body.removeChild(musicCredit);
            
            // Remove game credit box
            const gameCredit = document.getElementById('game-credit');
            if (gameCredit) document.body.removeChild(gameCredit);
            
            console.log('Instantiating Game with worldType=', worldType, 'multiplayer=', isMultiplayer, 'team=', team, 'name=', playerName, 'survival=', survivalMode, 'useServer=', useServer, 'color=', playerColor);
            const game = new Game(worldType, isMultiplayer, team, playerName, survivalMode, playerColor, playerEmail);
            // Expose for UI Connect button
            window._game = game;
            game.forceUnlockAudio();
            
            // Auto-connect to server if enabled
            if (useServer) {
                game.connectServer(serverHost, serverPort, serverPassword);
            }
            
            console.log('Game instantiated successfully');
        } catch (e) {
            console.error('Failed to instantiate Game:', e);
        }
    };
});
