const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('searchtopic')
        .setDescription('Search the Q&A meeting database for a specific topic or keyword')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The topic or keyword to search for')
                .setRequired(true)
        ),

    async execute(interaction) {
        const query = interaction.options.getString('query').toLowerCase();

        const dbPath = path.join(__dirname, "..", "database.json");
        if (!fs.existsSync(dbPath)) {
            return interaction.reply({ content: '❌ No Q&A database found yet.', flags: ['Ephemeral'] });
        }

        let database = [];
        try {
            database = JSON.parse(fs.readFileSync(dbPath, "utf8"));
        } catch (e) {
            return interaction.reply({ content: '❌ Error parsing the Q&A database.', flags: ['Ephemeral'] });
        }

        const hits = database.filter(entry =>
            (entry.topic && entry.topic.toLowerCase().includes(query)) ||
            (entry.question && entry.question.toLowerCase().includes(query)) ||
            (entry.answer && entry.answer.toLowerCase().includes(query))
        );

        if (hits.length === 0) {
            return interaction.reply({ content: `🔍 No results found matching \`${query}\`.`, flags: ['Ephemeral'] });
        }

        // Limit results to avoid Discord UI embed limits
        const displayHits = hits.slice(0, 5);

        const embeds = displayHits.map(hit => {
            return new EmbedBuilder()
                .setTitle(`📌 Topic: ${hit.topic || 'General'}`)
                .setColor(0x0099ff)
                .addFields(
                    { name: 'Question / Point', value: hit.question ? hit.question.substring(0, 1024) : 'N/A' },
                    { name: 'Answer / Conclusion', value: hit.answer ? hit.answer.substring(0, 1024) : 'N/A' }
                )
                .setFooter({ text: `Meeting: ${hit.meetingId || 'Unknown'} | Match ${hits.indexOf(hit) + 1} of ${hits.length}` });
        });

        await interaction.reply({
            content: `✅ Found **${hits.length}** results for \`${query}\`. Showing top ${displayHits.length}:`,
            embeds: embeds
        });
    }
};
