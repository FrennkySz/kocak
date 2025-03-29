const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APIKEY = 'tYYVlHk0ii';
const prefix = ['.', '!', '/', '#', '$'];

// Konfigurasi database - sesuaikan dengan credentials Niagahoster Anda
const dbConfig = {
    host: 'srv1864.hstgr.io', // ganti dengan host MySQL Anda
    user: 'u624027311_revinime', // ganti dengan username database Anda
    password: 'Yogiganz123#', // ganti dengan password database Anda
    database: 'u624027311_revinime',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
};

// Buat pool koneksi database
const pool = mysql.createPool(dbConfig);

// Fungsi untuk tes koneksi database
async function testDBConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('Database terhubung ke Niagahoster!');
        connection.release();
        return true;
    } catch (error) {
        console.error('Error koneksi database:', error.message);
        return false;
    }
}

function extractScore(ratingString) {
    // Mencoba mengekstrak angka dari string rating
    const matches = ratingString.match(/(\d+(\.\d+)?)/);
    if (matches && matches[1]) {
        return parseFloat(matches[1]);
    }
    return 0.00; // nilai default jika tidak ada angka yang ditemukan
}

function calculateSimilarity(title1, title2) {
    // Hapus "season" dan angka musim dari kedua judul
    const cleanTitle1 = title1.toLowerCase().replace(/season\s*\d+/gi, '').trim();
    const cleanTitle2 = title2.toLowerCase().replace(/season\s*\d+/gi, '').trim();
    
    // Pisahkan kata-kata dan buat set
    const set1 = new Set(cleanTitle1.split(' '));
    const set2 = new Set(cleanTitle2.split(' '));
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
}

// Fungsi untuk koneksi database
async function createDBConnection() {
    return await mysql.createConnection(dbConfig);
}

// Add this after the pool creation
async function downloadImage(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data, 'binary');
}

const NOTIFICATION_GROUP = '120363414092833360@g.us'; // Ganti dengan ID grup yang diinginkan
const CHECK_INTERVAL = 30 * 60 * 1000; // Cek setiap 5 menit

// Tambahkan fungsi untuk mengecek update terbaru
async function checkLatestUpdates(sock) {
    try {
        const response = await axios.get('https://api.maelyn.tech/api/otakudesu/lastupdate?apikey=tYYVlHk0ii');
        const latestAnimes = response.data.result;
        
        // Baca data terakhir yang sudah dinotifikasi
        let lastNotified = {};
        try {
            if (fs.existsSync('last_notified.json')) {
                lastNotified = JSON.parse(fs.readFileSync('last_notified.json', 'utf8'));
            }
        } catch (error) {
            console.error('Error membaca file last_notified.json:', error);
        }

        // Cek anime baru
        for (const anime of latestAnimes) {
            const key = `${anime.judul}-${anime.episode}`;
            if (!lastNotified[key]) {
                try {
                    // Download thumbnail
                    const thumbnailBuffer = await downloadImage(anime.thumbnail);
                    
                    // Buat pesan notifikasi
                    const message = `🔥 *ANIME UPDATE!* 🔥\n\n` +
                                  `📺 *${anime.judul}*\n` +
                                  `🎬 ${anime.episode}\n` +
                                  `📅 ${anime.tanggal}\n` +
                                  `📌 Hari: ${anime.hari}\n` +
                                  `🔗 Link: ${anime.link}\n\n` +
                                  `Gunakan perintah .anime untuk informasi lebih detail!`;

                    // Kirim notifikasi dengan thumbnail
                    await sock.sendMessage(NOTIFICATION_GROUP, {
                        image: thumbnailBuffer,
                        caption: message
                    });

                    // Tambahkan proses penambahan ke database
                    console.log(`🔄 Memulai proses penambahan ${anime.judul} ke database...`);

                    try {
                        // Ambil detail anime
                        const detailResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/detail?url=${encodeURIComponent(anime.link)}&apikey=${APIKEY}`);
                        const details = detailResponse.data.result;

                        // Buat koneksi database
                        const connection = await createDBConnection();

                        // Cek apakah anime sudah ada di database
                        const [existingAnime] = await connection.execute(
                            'SELECT id FROM anime WHERE title = ?',
                            [details.judul]
                        );

                        let animeId;
                        let relatedAnimeIds = [];

                        // Cari anime yang mirip
                        const [allAnimes] = await connection.execute('SELECT id, title FROM anime');
                        const similarAnimes = allAnimes
                            .map(a => ({
                                ...a,
                                similarity: calculateSimilarity(details.judul, a.title)
                            }))
                            .filter(a => a.similarity > 0.3)
                            .sort((a, b) => b.similarity - a.similarity);

                        relatedAnimeIds = similarAnimes.map(a => a.id);

                        // Tentukan rating, tipe, dan status
                        let dbRating = 'Usia 13+';
                        if (details.rating.includes('17')) dbRating = 'Usia 17+';
                        else if (details.rating.includes('7')) dbRating = 'Usia 7+';
                        else if (details.rating.includes('5')) dbRating = 'Usia 5+';

                        let dbType = 'TV';
                        if (details.tipe.includes('Movie')) dbType = 'Movie';
                        else if (details.tipe.includes('BD')) dbType = 'BD';
                        else if (details.tipe.includes('OVA')) dbType = 'OVA';

                        let dbStatus = 'Completed';
                        if (details.anime_status.includes('Ongoing')) dbStatus = 'Ongoing';
                        else if (details.anime_status.includes('Upcoming')) dbStatus = 'Upcoming';

                        if (existingAnime.length > 0) {
                            animeId = existingAnime[0].id;
                            await connection.execute(
                                'UPDATE anime SET related_anime = ? WHERE id = ?',
                                [relatedAnimeIds.join(','), animeId]
                            );
                            console.log(`✅ Updated anime: ${details.judul} (ID: ${animeId})`);
                        } else {
                            // Insert anime baru
                            const [result] = await connection.execute(
                                `INSERT INTO anime (
                                    title, title_japanese, image_url, synopsis, type, 
                                    status, rating, score, duration, studio, genres, related_anime
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                [
                                    details.judul, details.japanese, details.thumbnail,
                                    details.sinopsis, dbType, dbStatus, dbRating,
                                    extractScore(details.rating), details.durasi,
                                    details.studio, details.genre, relatedAnimeIds.join(',')
                                ]
                            );
                            animeId = result.insertId;
                            console.log(`✅ Added new anime: ${details.judul} (ID: ${animeId})`);
                        }

                        // Proses episode jika ada
                        if (details.epsd_url && details.epsd_url.length > 0) {
                            for (const episode of details.epsd_url) {
                                const episodeMatch = episode.title.match(/episode\s*(\d+)/i);
                                if (!episodeMatch) continue;

                                const episodeNumber = parseInt(episodeMatch[1]);
                                const [existingEpisode] = await connection.execute(
                                    'SELECT id FROM episodes WHERE anime_id = ? AND episode_number = ?',
                                    [animeId, episodeNumber]
                                );

                                if (existingEpisode.length === 0) {
                                    const streamResponse = await axios.get(
                                        `https://api.maelyn.tech/api/otakudesu/stream?url=${encodeURIComponent(episode.epsd_url)}&apikey=${APIKEY}`
                                    );
                                    const streamData = streamResponse.data;

                                    if (streamData.status === "Success") {
                                        const qualityPriority = ['720', '480', '360'];
                                        let selectedQuality = null;
                                        let selectedServer = null;

                                        for (const priority of qualityPriority) {
                                            const qualityData = streamData.result.find(q => q.quality.includes(priority));
                                            if (qualityData) {
                                                const validServer = qualityData.serverList.find(s => 
                                                    !s.server.toLowerCase().includes('vidhide') && 
                                                    !s.streamUrl.toLowerCase().includes('vidhide')
                                                );
                                                
                                                if (validServer) {
                                                    selectedQuality = qualityData;
                                                    selectedServer = validServer;
                                                    break;
                                                }
                                            }
                                        }

                                        if (selectedQuality && selectedServer) {
                                            await connection.execute(
                                                `INSERT INTO episodes (
                                                    anime_id, episode_number, video_url,
                                                    quality, uploaded_by
                                                ) VALUES (?, ?, ?, ?, ?)`,
                                                [
                                                    animeId, episodeNumber, selectedServer.streamUrl,
                                                    selectedQuality.quality, 'Auto Update System'
                                                ]
                                            );
                                            console.log(`✅ Added episode ${episodeNumber} for ${details.judul}`);
                                        }
                                    }
                                }
                            }
                        }

                        await connection.end();

                    } catch (dbError) {
                        console.error('Error saat menambahkan ke database:', dbError);
                    }

                    // Update data terakhir yang dinotifikasi
                    lastNotified[key] = {
                        timestamp: Date.now(),
                        data: anime
                    };

                    // Simpan ke file
                    fs.writeFileSync('last_notified.json', JSON.stringify(lastNotified, null, 2));

                    // Tunggu 1 detik sebelum mengirim notifikasi berikutnya
                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (error) {
                    console.error(`Error mengirim notifikasi untuk ${anime.judul}:`, error);
                }
            }
        }

        // Bersihkan data lama (lebih dari 7 hari)
        const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        for (const key in lastNotified) {
            if (lastNotified[key].timestamp < oneWeekAgo) {
                delete lastNotified[key];
            }
        }
        fs.writeFileSync('last_notified.json', JSON.stringify(lastNotified, null, 2));

    } catch (error) {
        console.error('Error mengecek update anime:', error);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log('Bot terhubung!');
            
            // Mulai pengecekan update secara berkala
            setInterval(() => checkLatestUpdates(sock), CHECK_INTERVAL);
            
            // Cek update pertama kali
            checkLatestUpdates(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    async function downloadImage(url) {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary');
    }

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        
        if (!m.message) return;
        
        // Tambahkan console log untuk notifikasi pesan
        console.log(`\nID: ${m.key.remoteJid}\nPushname: ${m.pushName || 'Tidak ada nama'}\nChat: ${m.message?.conversation || m.message?.extendedTextMessage?.text || 'Media'}\n`);
        
        const messageType = Object.keys(m.message)[0];
        const messageContent = m.message[messageType];
        
        if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
            const text = messageType === 'conversation' ? messageContent : messageContent.text;
            
            const prefixUsed = prefix.find(p => text.startsWith(p));
            if (!prefixUsed) return;

            const cmd = text.slice(prefixUsed.length).trim().split(/ +/).shift().toLowerCase();
            const args = text.slice(prefixUsed.length).trim().split(/ +/).slice(1);

            switch(cmd) {
                case 'anime':
                    if (!args[0]) {
                        await sock.sendMessage(m.key.remoteJid, { 
                            text: 'Silakan masukkan judul anime yang ingin dicari!',
                            quoted: m 
                        });
                        return;
                    }

                    try {
                        const query = args.join(' ');
                        const searchResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/search?q=${encodeURIComponent(query)}&apikey=${APIKEY}`);
                        const searchResults = searchResponse.data.result;

                        if (searchResults.length === 0) {
                            await sock.sendMessage(m.key.remoteJid, { 
                                text: 'Anime tidak ditemukan!',
                                quoted: m
                            });
                            return;
                        }

                        // Send total results message
                        await sock.sendMessage(m.key.remoteJid, { 
                            text: `- *HASIL PENCARIAN ANIME* -\nDitemukan ${searchResults.length} hasil untuk "${query}"\n\nMohon tunggu, sedang memproses data...`,
                            quoted: m
                        });

                        for (let i = 0; i < searchResults.length; i++) {
                            const anime = searchResults[i];
                            const detailResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/detail?url=${encodeURIComponent(anime.link)}&apikey=${APIKEY}`);
                            const details = detailResponse.data.result;

                            let message = `- *${details.judul}* -\n\n`;
                            message += `- Judul Jepang: ${details.japanese}\n`;
                            message += `- Rating: ${details.rating}\n`;
                            message += `- Tipe: ${details.tipe}\n`;
                            message += `- Total Episode: ${details.total_episode}\n`;
                            message += `- Durasi: ${details.durasi}\n`;
                            message += `- Tanggal Rilis: ${details.rilis}\n`;
                            message += `- Studio: ${details.studio}\n`;
                            message += `- Genre: ${details.genre}\n`;
                            message += `- Status: ${details.anime_status}\n\n`;
                            message += `Synopsis: ${details.sinopsis}\n\n`;
                            message += `- Link: ${anime.link}\n`;
                            message += `- Thumbnail: ${details.thumbnail}\n\n`;

                            if (details.epsd_url && details.epsd_url.length > 0) {
                                message += '- *Daftar Episode:* -\n';
                                const sortedEpisodes = [...details.epsd_url].reverse();
                                sortedEpisodes.forEach((episode, index) => {
                                    message += `${index + 1}. ${episode.title}\n${episode.epsd_url}\n`;
                                });
                            }

                            try {
                                const thumbnailBuffer = await downloadImage(details.thumbnail);
                                await sock.sendMessage(m.key.remoteJid, {
                                    image: thumbnailBuffer,
                                    caption: message,
                                    quoted: m
                                });
                            } catch (error) {
                                await sock.sendMessage(m.key.remoteJid, { 
                                    text: message,
                                    quoted: m
                                });
                            }

                            if (i < searchResults.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }
                        }

                    } catch (error) {
                        console.error('Error:', error);
                        await sock.sendMessage(m.key.remoteJid, { 
                            text: 'Terjadi kesalahan saat mencari anime!',
                            quoted: m
                        });
                    }
                    break;

                case 'stream':
                    if (!args[0]) {
                        await sock.sendMessage(m.key.remoteJid, { 
                            text: 'Silakan masukkan URL episode yang ingin distreaming!',
                            quoted: m
                        });
                        return;
                    }
            
                    try {
                        const episodeUrl = args[0];
                        const streamResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/stream?url=${encodeURIComponent(episodeUrl)}&apikey=${APIKEY}`);
                        const streamData = streamResponse.data;
            
                        if (streamData.status !== "Success") {
                            await sock.sendMessage(m.key.remoteJid, { 
                                text: 'Link streaming tidak ditemukan!',
                                quoted: m
                            });
                            return;
                        }
            
                        let streamMessage = `- *LINK STREAMING* -\n\n`;
                        
                        streamData.result.forEach((quality) => {
                            streamMessage += `Kualitas: ${quality.quality}\n`;
                            streamMessage += `Server yang tersedia:\n`;
                            
                            quality.serverList.forEach((server) => {
                                streamMessage += `- ${server.server}: ${server.streamUrl}\n`;
                            });
                            
                            streamMessage += `\n`;
                        });
            
                        await sock.sendMessage(m.key.remoteJid, { 
                            text: streamMessage,
                            quoted: m
                        });
            
                    } catch (error) {
                        console.error('Error:', error);
                        await sock.sendMessage(m.key.remoteJid, { 
                            text: 'Terjadi kesalahan saat mengambil link streaming!',
                            quoted: m
                        });
                    }
                    break;
            
                case 'menu':
                    const prefixList = prefix.join(', ');
                    const menuMessage = `- *MENU BOT ANIME* -\n\n` +
                                      `Prefix yang tersedia: ${prefixList}\n\n` +
                                      `- anime [judul]\n` +
                                      `  Mencari anime berdasarkan judul\n` +
                                      `  Contoh: ${prefix[0]}anime shadows house\n\n` +
                                      `- stream [url]\n` +
                                      `  Mengambil link streaming dari episode\n` +
                                      `  Contoh: ${prefix[0]}stream https://otakudesu.cloud/episode/sl-s2-episode-12-sub-indo/\n\n` +
                                      `- menu\n` +
                                      `  Menampilkan daftar perintah\n`;
                    
                    await sock.sendMessage(m.key.remoteJid, { 
                        text: menuMessage,
                        quoted: m
                    });
                    break;

                    case 'addanime':
    if (!args[0]) {
        await sock.sendMessage(m.key.remoteJid, { 
            text: 'Silakan masukkan judul atau URL anime yang ingin ditambahkan!',
            quoted: m 
        });
        return;
    }

    try {
        let animeList = [];

        // Cek apakah input adalah URL
        if (args[0].startsWith('http')) {
            const detailResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/detail?url=${encodeURIComponent(args[0])}&apikey=${APIKEY}`);
            animeList = [detailResponse.data.result];
        } else {
            const query = args.join(' ');
            const searchResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/search?q=${encodeURIComponent(query)}&apikey=${APIKEY}`);
            const searchResults = searchResponse.data.result;

            if (searchResults.length === 0) {
                await sock.sendMessage(m.key.remoteJid, { 
                    text: 'Anime tidak ditemukan!',
                    quoted: m
                });
                return;
            }

            await sock.sendMessage(m.key.remoteJid, { 
                text: `Ditemukan ${searchResults.length} anime dengan kata kunci "${query}"\nMemulai proses penambahan...`,
                quoted: m
            });

            for (const result of searchResults) {
                const detailResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/detail?url=${encodeURIComponent(result.link)}&apikey=${APIKEY}`);
                animeList.push(detailResponse.data.result);
            }
        }

        // Buat message status untuk setiap anime
        const statusMessages = {};
        for (const details of animeList) {
            const initialMessage = await sock.sendMessage(m.key.remoteJid, { 
                text: `🎯 Memulai proses untuk "${details.judul}"...\nStatus: Menunggu`,
                quoted: m
            });
            statusMessages[details.judul] = initialMessage.key;
        }

        // Proses setiap anime yang ditemukan
        for (const details of animeList) {
            let progressText = `🎯 Memproses "${details.judul}"...\n\n`;
            let relatedAnimeIds = [];
            let dbRating = 'Usia 13+';
            if (details.rating.includes('17')) dbRating = 'Usia 17+';
            else if (details.rating.includes('7')) dbRating = 'Usia 7+';
            else if (details.rating.includes('5')) dbRating = 'Usia 5+';

            let dbType = 'TV';
            if (details.tipe.includes('Movie')) dbType = 'Movie';
            else if (details.tipe.includes('BD')) dbType = 'BD';
            else if (details.tipe.includes('OVA')) dbType = 'OVA';

            let dbStatus = 'Completed';
            if (details.anime_status.includes('Ongoing')) dbStatus = 'Ongoing';
            else if (details.anime_status.includes('Upcoming')) dbStatus = 'Upcoming';

            const connection = await createDBConnection();

            // Update status: Mencari anime yang mirip
            progressText += `🔍 Mencari anime yang mirip...\n`;
            await sock.sendMessage(m.key.remoteJid, { 
                edit: statusMessages[details.judul],
                text: progressText
            });

            const [allAnimes] = await connection.execute('SELECT id, title FROM anime');
            const similarAnimes = allAnimes
                .map(anime => ({
                    ...anime,
                    similarity: calculateSimilarity(details.judul, anime.title)
                }))
                .filter(anime => anime.similarity > 0.3)
                .sort((a, b) => b.similarity - a.similarity);

            if (similarAnimes.length > 0) {
                relatedAnimeIds = similarAnimes.map(anime => anime.id);
                const similarityReport = similarAnimes
                    .map(anime => {
                        const similarity = (anime.similarity * 100).toFixed(1);
                        return `- ${anime.title} (ID: ${anime.id}, Kemiripan: ${similarity}%)`;
                    })
                    .join('\n');

                progressText += `✅ Ditemukan ${similarAnimes.length} anime yang mirip:\n${similarityReport}\n\n`;
            } else {
                progressText += `ℹ️ Tidak ditemukan anime yang mirip\n\n`;
            }

            // Update status
            await sock.sendMessage(m.key.remoteJid, { 
                edit: statusMessages[details.judul],
                text: progressText
            });

            // Proses penambahan/update anime di database
            const [existingAnime] = await connection.execute(
                'SELECT id FROM anime WHERE title = ?',
                [details.judul]
            );

            let animeId;
            if (existingAnime.length > 0) {
                animeId = existingAnime[0].id;
                progressText += `📝 Anime sudah ada di database (ID: ${animeId})\n`;
                await connection.execute(
                    'UPDATE anime SET related_anime = ? WHERE id = ?',
                    [relatedAnimeIds.join(','), animeId]
                );
                progressText += `✅ Related anime diperbarui\n\n`;
            } else {
                // Insert anime baru
                const [result] = await connection.execute(
                    `INSERT INTO anime (
                        title, title_japanese, image_url, synopsis, type, 
                        status, rating, score, duration, studio, genres, related_anime
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        details.judul, details.japanese, details.thumbnail,
                        details.sinopsis, dbType, dbStatus, dbRating,
                        extractScore(details.rating), details.durasi,
                        details.studio, details.genre, relatedAnimeIds.join(',')
                    ]
                );
                animeId = result.insertId;
                progressText += `✅ Anime baru ditambahkan (ID: ${animeId})\n\n`;
            }

            // Update status
            await sock.sendMessage(m.key.remoteJid, { 
                edit: statusMessages[details.judul],
                text: progressText
            });

            // Proses episode
            if (details.epsd_url && details.epsd_url.length > 0) {
                progressText += `📥 Memproses ${details.epsd_url.length} episode...\n`;
                await sock.sendMessage(m.key.remoteJid, { 
                    edit: statusMessages[details.judul],
                    text: progressText
                });

                const sortedEpisodes = [...details.epsd_url].sort((a, b) => {
                    const getEpisodeNumber = (title) => {
                        const matches = title.match(/episode\s*(\d+)/i);
                        return matches ? parseInt(matches[1]) : 0;
                    };
                    return getEpisodeNumber(a.title) - getEpisodeNumber(b.title);
                });

                for (const episode of sortedEpisodes) {
                    try {
                        const episodeMatch = episode.title.match(/episode\s*(\d+)/i);
                        if (!episodeMatch) {
                            progressText += `⚠️ Gagal mengekstrak nomor episode: ${episode.title}\n`;
                            continue;
                        }
                        const episodeNumber = parseInt(episodeMatch[1]);

                        const [existingEpisode] = await connection.execute(
                            'SELECT id FROM episodes WHERE anime_id = ? AND episode_number = ?',
                            [animeId, episodeNumber]
                        );

                        if (existingEpisode.length > 0) {
                            progressText += `⏭️ Episode ${episodeNumber} sudah ada\n`;
                            continue;
                        }

                        const streamResponse = await axios.get(`https://api.maelyn.tech/api/otakudesu/stream?url=${encodeURIComponent(episode.epsd_url)}&apikey=${APIKEY}`);
                        const streamData = streamResponse.data;

                        if (streamData.status === "Success") {
                            const qualityPriority = ['720', '480', '360'];
                            let selectedQuality = null;
                            let selectedServer = null;

                            for (const priority of qualityPriority) {
                                const qualityData = streamData.result.find(q => q.quality.includes(priority));
                                if (qualityData) {
                                    const validServer = qualityData.serverList.find(s => 
                                        !s.server.toLowerCase().includes('vidhide') && 
                                        !s.streamUrl.toLowerCase().includes('vidhide')
                                    );
                                    
                                    if (validServer) {
                                        selectedQuality = qualityData;
                                        selectedServer = validServer;
                                        break;
                                    }
                                }
                            }

                            if (selectedQuality && selectedServer) {
                                await connection.execute(
                                    `INSERT INTO episodes (
                                        anime_id, episode_number, video_url,
                                        quality, uploaded_by
                                    ) VALUES (?, ?, ?, ?, ?)`,
                                    [
                                        animeId, episodeNumber, selectedServer.streamUrl,
                                        selectedQuality.quality, 'Bot System'
                                    ]
                                );

                                progressText += `✅ Episode ${episodeNumber} (${selectedQuality.quality})\n`;
                            } else {
                                progressText += `⚠️ Episode ${episodeNumber}: Tidak ada server yang sesuai\n`;
                            }
                        }

                        // Update status setiap 5 episode atau ketika ada error
                        if (episodeNumber % 5 === 0 || progressText.length > 3000) {
                            await sock.sendMessage(m.key.remoteJid, { 
                                edit: statusMessages[details.judul],
                                text: progressText
                            });
                            // Reset progressText jika terlalu panjang
                            if (progressText.length > 3000) {
                                progressText = `🎯 Proses "${details.judul}" (lanjutan)...\n\n`;
                            }
                        }

                        await new Promise(resolve => setTimeout(resolve, 1000));

                    } catch (error) {
                        console.error(`Error saat memproses episode:`, error);
                        progressText += `❌ Error: ${error.message}\n`;
                        await sock.sendMessage(m.key.remoteJid, { 
                            edit: statusMessages[details.judul],
                            text: progressText
                        });
                    }
                }
            }

            await connection.end();
            progressText += `\n✅ Selesai memproses "${details.judul}"\n`;
            await sock.sendMessage(m.key.remoteJid, { 
                edit: statusMessages[details.judul],
                text: progressText
            });

            // Tunggu sebentar sebelum memproses anime berikutnya
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

    } catch (error) {
        console.error('Error:', error);
        await sock.sendMessage(m.key.remoteJid, { 
            text: `❌ Terjadi kesalahan: ${error.message}`,
            quoted: m
        });
    }
    break;

    case 'update':
    try {
        // Kirim pesan awal
        const initialMsg = await sock.sendMessage(m.key.remoteJid, { 
            text: '🔄 Memulai proses update related_anime untuk semua anime...\n\nProses ini mungkin memakan waktu beberapa menit.',
            quoted: m
        });

        const connection = await createDBConnection();
        
        // Ambil semua anime dari database
        const [allAnimes] = await connection.execute('SELECT id, title FROM anime');
        let progressText = '';
        let processedCount = 0;

        // Proses setiap anime
        for (const anime of allAnimes) {
            const similarAnimes = allAnimes
                .filter(a => a.id !== anime.id) // Exclude diri sendiri
                .map(a => ({
                    ...a,
                    similarity: calculateSimilarity(anime.title, a.title)
                }))
                .filter(a => a.similarity > 0.3)
                .sort((a, b) => b.similarity - a.similarity);

            const relatedAnimeIds = similarAnimes.map(a => a.id);

            // Update database
            await connection.execute(
                'UPDATE anime SET related_anime = ? WHERE id = ?',
                [relatedAnimeIds.join(','), anime.id]
            );

            processedCount++;

            // Buat teks progress
            progressText = `🔄 Progress: ${processedCount}/${allAnimes.length} anime\n\n`;
            progressText += `Terakhir diproses: ${anime.title}\n`;
            if (similarAnimes.length > 0) {
                progressText += `Anime terkait ditemukan: ${similarAnimes.length}\n`;
                progressText += similarAnimes.slice(0, 3).map(a => 
                    `- ${a.title} (${(a.similarity * 100).toFixed(1)}% mirip)`
                ).join('\n');
                if (similarAnimes.length > 3) {
                    progressText += `\n...dan ${similarAnimes.length - 3} lainnya`;
                }
            } else {
                progressText += 'Tidak ada anime terkait yang ditemukan';
            }

            // Update pesan status setiap 5 anime atau di akhir
            if (processedCount % 5 === 0 || processedCount === allAnimes.length) {
                await sock.sendMessage(m.key.remoteJid, { 
                    edit: initialMsg.key,
                    text: progressText
                });
            }
        }

        await connection.end();

        // Kirim pesan selesai
        await sock.sendMessage(m.key.remoteJid, { 
            text: `✅ Proses update selesai!\nTotal anime yang diproses: ${allAnimes.length}`,
            quoted: m
        });

    } catch (error) {
        console.error('Error:', error);
        await sock.sendMessage(m.key.remoteJid, { 
            text: `❌ Terjadi kesalahan saat update: ${error.message}`,
            quoted: m
        });
    }
    break;
            }
        }
    });
}

connectToWhatsApp();