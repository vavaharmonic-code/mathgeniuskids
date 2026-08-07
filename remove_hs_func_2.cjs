const fs = require("fs");
let html = fs.readFileSync("index.html", "utf8");

const startStr = "function generateHigherSecondaryQuestions(std) {";
const endMarker = "rawQuestions.forEach((q, idx) => {";
const endBlockMarker = "renderQuestionGrid();\n        }";

const startIndex = html.indexOf(startStr);
const endIndex = html.indexOf(endBlockMarker, startIndex);

if (startIndex !== -1 && endIndex !== -1) {
    const totalEnd = endIndex + endBlockMarker.length;
    html = html.substring(0, startIndex) + html.substring(totalEnd);
    fs.writeFileSync("index.html", html, "utf8");
    console.log("Successfully removed generateHigherSecondaryQuestions body!");
} else {
    console.error("Could not find start/end indices!", { startIndex, endIndex });
}
