const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const fs = require("fs");
const path = require("path");

// Test 1: Arial
const c1 = createCanvas(400, 70);
const ctx1 = c1.getContext("2d");
ctx1.fillStyle = "#FFD700";
ctx1.fillRect(0, 0, 400, 70);
ctx1.fillStyle = "#111111";
ctx1.font = "bold 28px Arial";
ctx1.textAlign = "center";
ctx1.textBaseline = "middle";
ctx1.fillText("etaj 3 din 4", 200, 35);
fs.writeFileSync("test1-arial.png", c1.toBuffer("image/png"));
console.log("Test 1 (Arial) saved -> test1-arial.png");

// Test 2: NotoSans registered
GlobalFonts.registerFromPath(path.join(__dirname, "fonts", "NotoSans-Bold.ttf"), "NotoSans");
const c2 = createCanvas(400, 70);
const ctx2 = c2.getContext("2d");
ctx2.fillStyle = "#FFD700";
ctx2.fillRect(0, 0, 400, 70);
ctx2.fillStyle = "#111111";
ctx2.font = "bold 28px NotoSans";
ctx2.textAlign = "center";
ctx2.textBaseline = "middle";
ctx2.fillText("etaj 3 din 4", 200, 35);
fs.writeFileSync("test2-notosans.png", c2.toBuffer("image/png"));
console.log("Test 2 (NotoSans) saved -> test2-notosans.png");

console.log("Deschide test1-arial.png si test2-notosans.png sa vezi care merge.");
