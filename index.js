const {Client, Intents, MessageActionRow, MessageButton} = require('discord.js');
const discord = new Client({intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES]});
const axios = require('axios');
const vision = require('@google-cloud/vision');
const moment = require('moment');
require('dotenv').config();

const bossMap = require('./boss-map.json');

const {
    RARE_DROP_DICE_CATEGORY_ID,
    RARE_DROP_DICE_CREATE_CHANNEL_ID,
    GOOGLE_APPLICATION_CREDENTIALS,
    MONITORING_CATEGORY_ID,
    DISCORD_TOKEN,
} = process.env;

discord.once('ready', () => {
    console.log(`Logged in as ${discord.user.tag}!`);
});

discord.on('messageCreate', async (message) => {
    
    // 画像処理するカテゴリーないのメッセージか調べる
    if (message.channel.parentId !== MONITORING_CATEGORY_ID) {
        return;
    }

    // メッセージから画像URLを探す
    let url;
    try {
        const attachment = message.attachments.keys().next();
        if (attachment.value) {
            // 通常画像貼り付けメッセージ
            url = message.attachments.get(attachment.value).url;
        } else if (message.embeds.length > 0) {
            const embed = message.embeds[0];

            // Gyazoからのメッセージ
            if (embed.title === 'Gyazo') {
                url = `${embed.url}.png`;
            }
        }
    } catch (e) {
    }

    // urlが取得できなかった場合は終了
    if (!url) {
        return;
    }

    try {
        // メッセージowner
        const guildMember = await message.guild.members.fetch(message.author.id);
        const ownerName = (guildMember.displayName ? guildMember.displayName : guildMember.user.username)
            .match(/(【.+】)?(.+)/)[2];

        // 画像を取得してbase64エンコードする。
        const response = await axios.get(url, {responseType: 'arraybuffer'});
        const base64 = new Buffer(response.data, "binary").toString("base64");
        // OCR
        const drops = await detectImage(base64, ownerName);
        // メッセージを返却する
        let row = new MessageActionRow();
        for (const drop of drops) {
            // ダイス作成ボタン
            const bossName = bossMap.hasOwnProperty(drop.place) ? bossMap[drop.place] : drop.place
            row.addComponents(
                new MessageButton()
                    .setCustomId(`CREATE_DICE::${drop.owner}::${bossName}::${drop.item}`)
                    .setLabel(`${drop.item} > ${drop.owner}@${bossName}`)
                    .setStyle('PRIMARY')
            );
        }
        const replyMessage = `ボタンを押してドロップアイテムのダイス会場を作成します。\n`
            + `解析結果が正確でない場合は、取得者・場所・アイテムがわかる画像で再度お試しください。\n\n` 
            + `<#${RARE_DROP_DICE_CREATE_CHANNEL_ID}> \`!make 所有者名 アイテム名 boss名\`\n\nでダイス会場を作成することもできます。`;

        await message.reply({content: replyMessage, components: [row]});
    } catch (e) {
        // うまく解析できなかった場合は終了
        console.log(e)
    }
});

// ボタン等のインタラクションを処理する
discord.on('interactionCreate', async (interaction) => {

    if (!interaction.isButton()) return;

    // customId = `CREATE_DICE::${drop.owner}::${place}::${drop.item}`
    const customId = interaction.customId;
    const drops = customId.split('::');
    if (drops.length > 0 && drops[0] === 'CREATE_DICE') {

        await createChannel(interaction.guildId, drops[1], drops[2], drops[3])
        const message = interaction.message;
        message.components[0].components
            .find(component => component.customId === customId)
            .setStyle('SUCCESS')
            .setDisabled(true)
        if (message.components[0].components.every(component => component.disabled)) {
            await interaction.update({content: '全てのダイスが開催されました', components: message.components});
        } else {
            await interaction.update({components: message.components});
        }
    } else {
        await interaction.reply({content: '対応するコマンドがありません'});
    }
});

discord.login();

async function detectImage(base64ed, ownerName) {
    const visionClient = new vision.ImageAnnotatorClient({credentials: JSON.parse(GOOGLE_APPLICATION_CREDENTIALS)});
    // const visionClient = new vision.ImageAnnotatorClient();

    const [result] = await visionClient.textDetection({
        image: {
            content: base64ed
        }
    });
    const detections = result.textAnnotations;

    
    const matcher = /(.*パーティ.+の)?(.+)が(.+)で(.+)を/;
    const text = detections.map(node => node.description)[0].replace(/[\n ]/g, '')
    let drops;
    drops = text.split(/獲得しました。?/)
        .filter(paragraph => matcher.test(paragraph))
        .map(paragraph => {
            const array = paragraph.match(matcher);
            return {
                owner: array[2].replace(/[|●■「]/g, ''),
                place: array[3],
                item: array[4]
            }
        });
    // 自分で拾った場合のログかもしれないので調べる
    if (drops.every(drop => drop.owner === '匿名の勇者')) {
        drops.forEach(drop => drop.owner = ownerName);
    }
    
    if (drops.length === 0) {
        const pattern = /(.+)を/;
        drops = text.split(/獲得しました。?/)
            .filter(paragraph => pattern.test(paragraph))
            .map(paragraph => {
                const array = paragraph.match(pattern);
                return {
                    owner: ownerName,
                    place: '不明',
                    item: array[1]
                }
            })
        console.log(drops);
    }
    const map = new Map();
    for (const drop of drops) {
        if (!map.has(drop.item)) {
            map.set(drop.item, drop)
        } else {
            if (drop.owner !== '匿名の勇者') {
                map.set(drop.item, drop);
            }
        }
    }

    return map.values();
}

async function createChannel(guildId, owner, bossName, item) {
    try {
        const time = moment()
            .add(1, 'hours')
            .set({'minute': 0, 'second': 0, 'millisecond': 0})
        const prefix = time.format('MMDD-HHmm')

        const guild = discord.guilds.cache.get(guildId);
        const channel = await guild.channels.create(`${prefix}-${item}`, {parent: RARE_DROP_DICE_CATEGORY_ID});
        await channel.send(`所持：${owner}\nボス名：${bossName}`)
    } catch (e) {
        console.log(e);
    }
}