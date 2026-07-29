require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');

const loadCommands = require('./handlers/commandHandler');
const loadEvents = require('./handlers/eventHandler');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

loadCommands(client);
loadEvents(client);

client.login(process.env.TOKEN);

console.log(loadEvents);