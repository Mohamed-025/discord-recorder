const { SlashCommandBuilder } = require('discord.js');
const sessions = require('../utils/sessions');
const recorder = require('../services/recorder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startrecord')
        .setDescription('Start recording'),

    async execute(interaction) {

        const session = sessions.get(interaction.guild.id);

        if (!session) {
            try {
                await interaction.reply({
                    content: '❌ The bot is not connected to a voice channel.',
                    flags: ['Ephemeral'],
                });
            } catch (error) {
                console.warn('Could not reply to startrecord command:', error.message);
            }
            return;
        }

        if (session.recording) {
            try {
                await interaction.reply({
                    content: '⚠️ Recording is already running.',
                    flags: ['Ephemeral'],
                });
            } catch (error) {
                console.warn('Could not reply to startrecord command:', error.message);
            }
            return;
        }

        try {
            await recorder.start(session);
        } catch (error) {
            console.error(error);
            try {
                await interaction.reply({
                    content: `❌ ${error.message}`,
                    flags: ['Ephemeral'],
                });
            } catch (replyError) {
                console.warn('Could not reply to startrecord command:', replyError.message);
            }
            return;
        }

        try {
            await interaction.reply('🎙️ Recording started.');
        } catch (error) {
            console.warn('Could not reply to startrecord command:', error.message);
        }
    },
};