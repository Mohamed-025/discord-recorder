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

        try {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            await interaction.editReply({ content: "⏳ Processing meeting..." });
        } catch (error) {
            console.warn('Could not defer or edit stoprecord reply:', error.message);
            // If defer fails, continue and send a normal reply later.
        }

        try {
            const meetingFolder = await recorder.stop(session);

            if (!meetingFolder || !fs.existsSync(meetingFolder)) {
                throw new Error("Recording was not generated properly.");
            }

            console.log("Processing Meeting Folder:", meetingFolder);

            const result = await meetingProcessor.process(meetingFolder);
            const outputPaths = await meetingProcessor.saveOutputs(meetingFolder, result);

            const fileName = path.basename(meetingFolder);
            const transcriptPath = outputPaths.transcriptPath;
            const summaryPath = outputPaths.summaryPath;

            const attachments = [transcriptPath, summaryPath].filter(f => fs.existsSync(f));
            if (result.meetingFiles && Array.isArray(result.meetingFiles)) {
                for (const mp3 of result.meetingFiles) {
                    if (attachments.length < 10 && fs.existsSync(mp3)) attachments.push(mp3);
                }
            }

            // Figure out where to send the final result
            let targetChannel = interaction.channel;
            if (session.destinationChannelId) {
                try {
                    const customChannel = await interaction.client.channels.fetch(session.destinationChannelId);
                    if (customChannel) targetChannel = customChannel;
                } catch (e) {
                    console.warn("Could not fetch target channel ID, falling back to execution channel.");
                }
            }

            const messagePayload = {
                content: `<@${interaction.user.id}> ✅ Meeting processing completed for **${fileName}**.\n\n📄 Generated Q&A Database Entries: ${result.qaData?.length || 0}`,
                files: attachments,
            };

            try {
                // We just send directly to the channel to avoid interaction timeouts entirely
                await targetChannel.send(messagePayload);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: `✅ Processing finished. Check out the results in <#${targetChannel.id}>!` });
                } else {
                    await interaction.reply({ content: `✅ Processing finished. Check out the results in <#${targetChannel.id}>!`, ephemeral: true });
                }
            } catch (error) {
                console.warn('Could not send final result to requested channel:', error.message);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: `❌ Failed to upload results. File sizes may exceed limits.` });
                } else {
                    await interaction.reply({ content: `❌ Failed to upload results. File sizes may exceed limits.`, ephemeral: true });
                }
            }

        } catch (error) {
            console.error(error);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: `❌ ${error.message}` });
                } else {
                    await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
                }
            } catch (replyError) {
                console.warn('Could not send stoprecord error reply:', replyError.message);
                try {
                    await interaction.channel.send({ content: `<@${interaction.user.id}> ❌ ${error.message}` });
                } catch (e) { }
            }
        }

    },
};