require("dotenv").config();

const meetingProcessor = require("./services/meetingProcessor");

(async () => {

    try {

        const result = await meetingProcessor.process("./audio.mp3");

        console.log("\n========== CLEANED TRANSCRIPT ==========\n");
        console.log(result.cleanedTranscript);

        console.log("\n========== SUMMARY ==========\n");
        console.log(result.summary);

    } catch (err) {

        console.error(err);

    }

})();
