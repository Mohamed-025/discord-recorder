const provider = process.env.AI_PROVIDER || "groq";

let ai;

switch (provider.toLowerCase()) {
    case "openai":
        ai = require("./providers/openai");
        break;

    case "groq":
        ai = require("./providers/groq");
        break;

    default:
        throw new Error(`Unknown AI provider: ${provider}`);
}

module.exports = ai;