import { Bot, InlineKeyboard, Keyboard, session } from "grammy";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();
// Ganti dengan token asli dari BotFather
const supabaseUrl = process.env.SUPABASE_URL; // Pastikan kamu sudah set variabel ini di .env
const supabaseKey = process.env.SUPABASE_KEY; // Pastikan kamu sudah set variabel ini di .env
const supabase = createClient(supabaseUrl, supabaseKey)
const bot = new Bot(process.env.BOT_TOKEN);

// Setup session
function initialSession() {
    return { step: null, data: {} };
}

bot.use(session({ initial: initialSession }));
// Setup keyboard untuk pengaturan
const settingsKeyboard = new InlineKeyboard()
    .text("🎂 Age", "set_age").row()
    .text("👤 Gender", "set_gender").row()
    .text("🌐 Language", "set_language").row()
    .text("❌ Close", "close_settings");

const reportKeyboard = new InlineKeyboard()
    .text("👍", "set_report_up")
    .text("👎", "set_report_down").row()
    .text("⚠️ Report ⚠️", "set_report");

const reportKeyboardList = new InlineKeyboard()
    .text("Advertise", "set_advertise").row()
    .text("Sexual Content", "set_sexual_content").row()
    .text("Harassment", "set_harassment").row()
    .text("Scam", "set_scam").row()
    .text("Other", "set_other").row()
    .text("⬅️ Back", "back_to_report");

// Set daftar perintah yang tampil di menu Telegram (sekali saat bot mulai)
async function setCommands() {
    await bot.api.setMyCommands([
        { command: "start", description: "Mulai bot" },
        { command: "help", description: "Lihat daftar perintah yang tersedia" },
        { command: "search", description: "Cari pasangan atau teman ngobrol" },
        { command: "next", description: "Lanjut ke pasangan berikutnya" },
        { command: "leave", description: "Keluar dari obrolan saat ini" },
        { command: "settings", description: "Atur preferensi kamu" },
    ]);
}

// Fungsi untuk mencari pasangan baru
async function searchPartner(userId) {
    try {
        // Cek apakah user sedang dalam chat
        const { data: existingUser } = await supabase
            .from('users')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (existingUser.status === 'chatting') {
            throw new Error('User sedang dalam chat. Harus keluar terlebih dahulu.');
        }

        // Update status user menjadi 'searching'
        await supabase
            .from("users")
            .upsert({ user_id: userId, status: "searching", partner_id: null },
                { onConflict: 'user_id' });

        // Mencari pasangan yang juga sedang mencari
        const { data: partner } = await supabase
            .from('users')
            .select('user_id')
            .eq('status', 'searching')
            .neq('user_id', userId) // Pastikan bukan user yang sama
            .limit(1)
            .maybeSingle();

        if (partner) {
            // Pasangkan user dengan pasangan yang ditemukan
            await bot.api.sendMessage(userId, "Partner ditemukan! Mulailah mengobrol.");
            await bot.api.sendMessage(partner.user_id, "Partner ditemukan! Mulailah mengobrol.");
            await supabase
                .from("session_chats")
                .insert([
                    {
                        user_id: userId,
                        partner_id: partner.user_id,
                        status: 'active'
                    }
                ])
                .single();

            // Update status kedua pengguna menjadi 'chatting'
            await supabase
                .from("users")
                .upsert([
                    { user_id: userId, status: "chatting", partner_id: partner.user_id, last_partner_id: partner.user_id },
                    { user_id: partner.user_id, status: "chatting", partner_id: userId, last_partner_id: userId },
                ], { onConflict: 'user_id' });

            return partner;
        } else {
            await bot.api.sendMessage(userId, "Sedang mencari pasangan baru...");

            return null;
        }
    } catch (error) {
        console.error(error);
        throw new Error(error.message || 'Terjadi kesalahan saat mencari pasangan.');
    }
}

// Fungsi untuk menangani keluar dari chat
async function leaveChat(userId) {
    try {
        // Update status chat yang aktif
        await supabase
            .from('session_chats')
            .update({ status: 'inactive' })
            .eq('status', 'active')  // Pastikan hanya yang memiliki status 'active'
            .or(`user_id.eq.${userId},partner_id.eq.${userId}`)  // Cek user_id atau partner_id
            .single();  // Ambil hanya satu record yang diupdate

        // Ambil data partner_id pengguna
        const { data: user } = await supabase
            .from("users")
            .select("partner_id")
            .eq("user_id", userId)
            .single();

        // Jika ada partner_id
        if (user.partner_id) {

            // Kirim pesan kepada user
            await bot.api.sendMessage(userId, "Kamu telah keluar dari chat.");
            await bot.api.sendMessage(userId, "Berikan report kepada partner jika kamu merasa tidak puas dengan obrolannya.", { reply_markup: reportKeyboard, });
            // Beri tahu partner bahwa user telah keluar
            await bot.api.sendMessage(user.partner_id, "Partner kamu telah keluar dari chat.\n\n" +
                "Cari pasangan baru dengan /search.");
            await bot.api.sendMessage(user.partner_id, "Berikan report kepada partner jika kamu merasa tidak puas dengan obrolannya.", { reply_markup: reportKeyboard, });

            // Reset kedua user jadi idle
            await supabase
                .from("users")
                .upsert([
                    { user_id: userId, status: "idle", partner_id: null },
                    { user_id: user.partner_id, status: "idle", partner_id: null },
                ], { onConflict: 'user_id' });
        } else {
            await supabase
                .from("users")
                .update({ status: "idle", partner_id: null })
                .eq("user_id", userId);
            await bot.api.sendMessage(userId, "Kamu tidak sedang dalam obrolan.\n\n" +
                "Cari pasangan baru dengan /search.");
        }
    } catch (error) {
        console.error("Error saat keluar dari chat:", error);
        throw new Error("Terjadi kesalahan saat mencoba keluar dari chat.");
    }
}

// Fungsi untuk meneruskan pesan ke partner
async function forwardToPartner(userId, partnerId, message) {
    let messageContent = null;
    let messageType = null;
    let fileId = null;

    if (message.text) {
        messageContent = message.text;
        messageType = "text";
        await bot.api.sendMessage(partnerId, message.text);
    } else if (message.sticker) {
        fileId = message.sticker.file_id;
        messageType = "sticker";
        await bot.api.sendSticker(partnerId, fileId);
    } else if (message.photo) {
        const photoArray = message.photo;
        fileId = photoArray[photoArray.length - 1].file_id;
        messageType = "photo";
        await bot.api.sendPhoto(partnerId, fileId, { messageContent: message.caption || "" });
    } else if (message.video) {
        fileId = message.video.file_id;
        messageType = "video";
        await bot.api.sendVideo(partnerId, fileId, { messageContent: message.caption || "" });
    } else if (message.voice) {
        fileId = message.voice.file_id;
        messageType = "voice";
        await bot.api.sendVoice(partnerId, fileId);
    } else if (message.audio) {
        fileId = message.audio.file_id;
        messageType = "audio";
        await bot.api.sendAudio(partnerId, fileId);
    } else {
        messageType = "unsupported";
        messageContent = "Jenis pesan tidak didukung.";
        await bot.api.sendMessage(partnerId, messageContent);
    }

    const { data: sessionChat } = await supabase
        .from('session_chats')
        .select('id')
        .eq('status', "active")
        .or(`user_id.eq.${userId},partner_id.eq.${userId}`)  // Cek user_id atau partner_id
        .single();
    if (!sessionChat) {
        console.error("Session chat tidak ditemukan untuk user dan partner ini.");
        return;
    }

    const { error } = await supabase
        .from('messages')
        .insert({
            session_chat_id: sessionChat.id,
            sender_id: userId,
            receiver_id: partnerId,
            message_type: messageType,
            content: messageContent || null,
            file_id: fileId || null, // Simpan file_id jika ada
            created_at: new Date().toISOString(),
        })
    if (error) {
        console.error(`Error simpan pesan ke Supabase: ${error.message}`);
    }
}
// Saat user kirim /start
bot.command("start", async (ctx) => {
    const user = ctx.from;

    const mainKeyboard = new Keyboard()
        .text("🔍 Find a partner").row()
        .text("⚙️ Settings").row()
        .oneTime()
        .resized();
    await ctx.reply(
        `Selamat datang di Cari Pacarku!\n\n` +
        `/search - Cari pasangan atau teman ngobrol\n` +
        `/next - Lanjut ke pasangan berikutnya\n` +
        `/leave - Keluar dari obrolan saat ini\n` +
        `/help - Lihat daftar perintah yang tersedia.\n` +
        `/settings - Atur profil kamu`
        , { reply_markup: mainKeyboard });
    // Simpan ke tabel 'users' di Supabase
    const { error } = await supabase
        .from('users')
        .upsert({   // upsert = insert or update by primary key
            user_id: user.id.toString(),  // simpan sebagai string supaya konsisten
            username: user.username || null,
            first_name: user.first_name || null,
            last_name: user.last_name || null,
            language_code: user.language_code || null,
            status: 'idle', // status awal
            partner_id: null, // tidak ada pasangan saat ini
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
    if (error) {
        console.error(`Error simpan ke Supabase: ${error.message}`);
    }


});

// Command /help
bot.command("help", async (ctx) => {
    await ctx.reply(
        `Daftar perintah:\n` +
        `/start - Mulai bot\n` +
        `/help - Lihat Daftar perintah yang tersedia\n` +
        `/search - Cari pasangan atau teman ngobrol\n` +
        `/next - Lanjut ke pasangan berikutnya\n` +
        `/leave - Keluar dari obrolan saat ini\n` +
        `/settings - Atur Profil kamu`
    );
});

// Command untuk keluar dari chat
bot.command('leave', async (ctx) => {
    const userId = ctx.from.id;

    try {
        // Panggil fungsi leaveChat untuk mengatur proses keluar
        await leaveChat(userId);

    } catch (error) {
        console.error("Error saat keluar dari chat:", error);
        await ctx.reply("Terjadi kesalahan saat mencoba keluar dari chat. Coba lagi nanti.");
    }
});

// Callback query handler untuk pengaturan
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const { data: user } = await supabase
        .from("users")
        .select("last_partner_id,partner_id, status")
        .eq("user_id", userId)
        .single();
    if (data === "back_to_settings") {
        await ctx.editMessageText("Pilih opsi pengaturan:", {
            reply_markup: settingsKeyboard,
        });
        await ctx.answerCallbackQuery();
    } else if (data === "back_to_report") {
        await ctx.editMessageText("Pilih opsi report:", {
            reply_markup: reportKeyboard,
        });
        await ctx.answerCallbackQuery();
    } else if (data === "set_report") {
        await ctx.editMessageText("Pilih jenis laporan:", {
            reply_markup: reportKeyboardList,
        });
        await ctx.answerCallbackQuery();
    } else if (data === "set_report_up" || data === "set_report_down") {
        await ctx.editMessageText("Terimakasih atas feedbacknya !");
        await ctx.answerCallbackQuery();
    } else if (data === "set_advertise" || data === "set_sexual_content" ||
        data === "set_harassment" || data === "set_scam" || data === "set_other") {
        const reportType = data.replace("set_", "").replace("_", " ");
        await ctx.editMessageText(`Kamu telah melaporkan pasangan karena: ${reportType}.`);
        // Ambil data laporan saat ini
        const { data: existingReport, error: fetchError } = await supabase
            .from('reports')
            .select('sum_report, report_type')
            .eq('user_id', user.last_partner_id.toString()) // Ganti user_id menjadi partner_id
            .single();
        const { error } = await supabase
            .from('reports')
            .upsert([
                {
                    user_id: user.last_partner_id.toString(),
                    sum_report: existingReport ? existingReport.sum_report + 1 : 1,
                    report_type: existingReport
                        ? `${existingReport.report_type}, ${reportType}`
                        : reportType,
                    created_at: new Date().toISOString(),
                }
            ], { onConflict: ['user_id'] }); // Pastikan ini sesuai dengan constraint unik

        await ctx.answerCallbackQuery();
    } else if (data === "set_gender") {
        await ctx.editMessageText("Pilih gender:", {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "👨‍🦱 Pria", callback_data: "set_pria" },
                        { text: "👩‍🦰 Wanita", callback_data: "set_wanita" },
                    ],
                    [{ text: "⬅️ Kembali", callback_data: "back_to_settings" }],
                ],
            },
        });
        await ctx.answerCallbackQuery();
    } else if (data === "set_pria" || data === "set_wanita") {
        const gender = data === "set_pria" ? "pria" : "wanita";
        await ctx.editMessageText(`Gender kamu telah diatur menjadi ${gender}.\n\n` +
            `Ketik /settings untuk membuka kembali pengaturan.`
        );
        const { error } = await supabase
            .from('users')
            .upsert({
                user_id: ctx.from.id.toString(),
                gender: gender,
            }, { onConflict: 'user_id' });
        if (error) {
            console.error(`Error simpan gender ke Supabase: ${error.message}`);
        }
        await ctx.answerCallbackQuery();
    } else if (data === "set_age") {
        ctx.session.step = "awaiting_age"; // Simpan step untuk menangani input usia
        await ctx.editMessageText("Masukkan usia kamu (dalam tahun):");
        await ctx.answerCallbackQuery();
    } else if (data === "set_language") {
        await ctx.editMessageText("Pilih bahasa:", {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🇮🇩 Indonesia", callback_data: "set_indonesia" },
                        { text: "🇬🇧 English", callback_data: "set_english" },
                    ],
                    [{ text: "⬅️ Kembali", callback_data: "back_to_settings" }],
                ],
            },
        });
        await ctx.answerCallbackQuery();
    } else if (data === "set_indonesia" || data === "set_english") {
        const language = data === "set_indonesia" ? "id" : "en";
        await ctx.editMessageText(`Bahasa kamu telah diatur menjadi ${language}.\n\n` +
            `Ketik /settings untuk membuka kembali pengaturan.`
        );
        const { error } = await supabase
            .from('users')
            .upsert({
                user_id: ctx.from.id.toString(),
                language_code: language,
            }, { onConflict: 'user_id' });
        if (error) {
            console.error(`Error simpan language ke Supabase: ${error.message}`);
        }
        await ctx.answerCallbackQuery();
    } else if (data === "close_settings") {
        await ctx.editMessageText(`Pengaturan ditutup.\n` +
            `Ketik /settings untuk membuka kembali pengaturan.`
        );
        await ctx.answerCallbackQuery();
    } else {
        await ctx.answerCallbackQuery();
    }
});

bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    const { data: user } = await supabase
        .from("users")
        .select("partner_id, status")
        .eq("user_id", userId)
        .single();
    if (ctx.message.text === "/search" || ctx.message.text === "🔍 Find a partner") {
        if (user.status === "searching") {
            await ctx.reply("Kamu sedang proses mencari pasangan.\n" +
                "Silakan gunakan /leave untuk keluar dari pencarian pasangan.");
            return;
        } else if (user.status === "chatting") {
            await ctx.reply("Kamu sedang dalam obrolan dengan pasangan.\n" +
                "Silakan gunakan /next untuk mencari pasangan lainnya.");
            return;

        } else {
            await searchPartner(userId);
            return;
        }
    } else if (ctx.message.text === "/next") {
        if (user.partner_id) {
            await leaveChat(userId);
        } else {
            await searchPartner(userId);
            return;
        }
    } else if (ctx.message.text === "/settings" || ctx.message.text === "⚙️ Settings") {
        await ctx.reply("Pilih opsi pengaturan:", {
            reply_markup: settingsKeyboard,
        });
        return;
    } else if (ctx.session.step === "awaiting_age") {
        const age = parseInt(ctx.message.text);
        if (isNaN(age) || age < 0 || age > 120) {
            await ctx.reply("Usia tidak valid. Silakan masukkan usia yang benar.");
            return;
        }
        // Simpan usia ke database
        await supabase
            .from('users')
            .upsert({
                user_id: userId.toString(),
                age: age,
            }, { onConflict: 'user_id' });

        ctx.session.step = null; // Reset step
        await ctx.reply(`Usia kamu telah diatur menjadi ${age} tahun.\n` +
            `Ketik /settings untuk membuka kembali pengaturan.`);
        return;
    } else if (!user.partner_id || user.status !== "chatting") {
        await ctx.reply("Kamu tidak sedang dalam obrolan.\n" +
            "Silakan gunakan /search untuk mencari pasangan baru.");
        return;
    } else {
        await forwardToPartner(userId, user.partner_id, ctx.message);
        return;
    }
});

// Jalankan bot dan set commands sekali saat startup
(async () => {
    await setCommands();
    await bot.start();
})();
