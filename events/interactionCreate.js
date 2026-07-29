module.exports = {
    name: 'interactionCreate',

    async execute(interaction) {

        if (!interaction.isChatInputCommand()) return;

        const command = interaction.client.commands.get(interaction.commandName);

        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);

            try {
                if (interaction.deferred || interaction.replied) {
                    try {
                        await interaction.followUp({
                            content: 'There was an error while executing this command!',
                            flags: ['Ephemeral'],
                        });
                    } catch (followUpError) {
                        if (followUpError?.code !== 10062 && followUpError?.code !== 40060) {
                            console.error('Failed to follow up interaction:', followUpError);
                        }
                    }
                } else {
                    try {
                        await interaction.reply({
                            content: 'There was an error while executing this command!',
                            flags: ['Ephemeral'],
                        });
                    } catch (replyError) {
                        if (replyError?.code !== 10062 && replyError?.code !== 40060) {
                            console.error('Failed to reply to interaction:', replyError);
                        }
                    }
                }
            } catch (replyError) {
                console.error('Failed to report interaction error:', replyError);
            }
        }
    },
};