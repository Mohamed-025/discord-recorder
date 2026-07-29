const { SlashCommandBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");

const sessions = require("../utils/sessions");
const recorder = require("../services/recorder");
const meetingProcessor = require("../services/meetingProcessor");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("stoprecord")
        .setDescription("Stop recording"),

    async execute(interaction) {

        const session = sessions.get(interaction.guild.id);

        if (!session) {
            try {
                await interaction.reply({
                    content: "❌ The bot is not connected.",
                    flags: ['Ephemeral'],
                });
            } catch (error) {
                console.warn('Could not reply to stoprecord command:', error.message);
            }
            return;
        }

        if (!session.recording) {
            try {
                await interaction.reply({
                    content: "⚠️ Recording is not running.",
                    flags: ['Ephemeral'],
                });
            } catch (error) {
                console.warn('Could not reply to stoprecord command:', error.message);
            }
            return;
        }

        const meetingFolder = session.meetingPath;

        if (!meetingFolder) {
            try {
                await interaction.reply({
                    content: "❌ No active meeting folder was found.",
                    flags: ['Ephemeral'],
                });
            } catch (error) {
                console.warn('Could not reply to stoprecord command:', error.message);
            }
            return;
        }

        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });
        } catch (error) {
            console.warn('Could not defer stoprecord reply:', error.message);
        }

        try {
            await interaction.editReply({ content: "⏳ Processing meeting..." });
        } catch (error) {
            console.warn('Could not update stoprecord reply:', error.message);
        }

        try {

            const meetingFile = await recorder.stop(session);

            if (!meetingFile || !fs.existsSync(meetingFile)) {
                throw new Error("Recording file was not created.");
            }

            console.log("Meeting file:", meetingFile);

            const result = await meetingProcessor.process(meetingFile);
            const outputPaths = await meetingProcessor.saveOutputs(meetingFolder, result);

            const fileName = path.basename(meetingFile);
            const transcriptPath = outputPaths.transcriptPath;
            const summaryPath = outputPaths.summaryPath;
            const attachments = [meetingFile, transcriptPath, summaryPath].filter((file) => fs.existsSync(file));

            try {
                await interaction.editReply({
                    content: `✅ Meeting processing completed.\n\n📄 Audio file: ${fileName}\n📄 Transcript: ${path.basename(transcriptPath)}\n📄 Summary: ${path.basename(summaryPath)}`,
                    files: attachments,
                });
            } catch (error) {
                console.warn('Could not send stoprecord completion reply:', error.message);
            }

        } catch (error) {

            console.error(error);

            try {
                await interaction.editReply({
                    content: `❌ ${error.message}`,
                });
            } catch (replyError) {
                console.warn('Could not send stoprecord error reply:', replyError.message);
            }

        }

    },
};