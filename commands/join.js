const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const sessions = require('../utils/sessions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join your voice channel'),

    async execute(interaction) {

        const channel = interaction.member.voice.channel;

        if (!channel) {
            try {
                await interaction.reply({
                    content: '❌ You need to join a voice channel first.',
                    flags: ['Ephemeral'],
                });
            } catch (error) {
                console.warn('Could not reply to join command:', error.message);
            }
            return;
        }

        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        sessions.set(channel.guild.id, {
            connection,
            recording: false,
        });

        console.log("Session created:", channel.guild.id);

        try {
            await interaction.reply(`✅ Joined ${channel.name}`);
        } catch (error) {
            console.warn('Could not reply to join command:', error.message);
        }
    }
};