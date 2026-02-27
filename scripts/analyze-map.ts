import { readFileSync } from "fs";

const d = JSON.parse(readFileSync("data/map_response.json", "utf8"));
const systems = d.result.systems;
console.log("Total systems:", systems.length);
console.log("System keys:", Object.keys(systems[0]));
console.log("");

// Check coordinates
const withCoords = systems.filter((s: any) => s.position && (s.position.x !== 0 || s.position.y !== 0));
console.log("Systems with coordinates:", withCoords.length);
const zeroCoords = systems.filter((s: any) => !s.position || (s.position.x === 0 && s.position.y === 0));
console.log("Systems with (0,0) coords:", zeroCoords.length);
console.log("");

// Check visits
const visited = systems.filter((s: any) => s.visited);
console.log("Visited systems:", visited.length);
const notVisited = systems.filter((s: any) => !s.visited);
console.log("Not visited systems:", notVisited.length);
console.log("");

// Check POIs
const withPois = systems.filter((s: any) => s.poi_count > 0);
console.log("Systems with POIs:", withPois.length);
const totalPois = systems.reduce((sum: number, s: any) => sum + (s.poi_count || 0), 0);
console.log("Total POIs across all systems:", totalPois);
console.log("");

// Check if POI data is included
const sample = systems.find((s: any) => s.poi_count > 2);
console.log("Sample system (many POIs):", JSON.stringify(sample, null, 2));
console.log("");

// Check connections
const totalConns = systems.reduce((sum: number, s: any) => sum + (s.connections?.length || 0), 0);
console.log("Total connections:", totalConns);

// Check if pois array is present
const hasPoisArray = systems.filter((s: any) => s.pois && Array.isArray(s.pois) && s.pois.length > 0);
console.log("Systems with pois[] array:", hasPoisArray.length);
