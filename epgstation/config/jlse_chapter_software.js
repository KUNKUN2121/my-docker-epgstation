// jlse で CM を検出し、CM をカットせずチャプター(本編/CM)を付けて x264 でソフトウェアエンコードし、MKV で出力する
const spawn = require('child_process').spawn;
const execFile = require('child_process').execFile;
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = process.env.FFMPEG;
const ffprobe = process.env.FFPROBE;
const input = process.env.INPUT;
const output = process.env.OUTPUT;
const isDualMono = parseInt(process.env.AUDIOCOMPONENTTYPE, 10) == 2;
// my settings (enc_software.js と同じ)
const audioBitrate = '60k';
const preset = 'veryfast';
const crf = 23;
const videoFilter = 'yadif,scale=-2:720';
// jlse の結果出力先(コンテナ内)
const JLSE_RESULT_DIR = '/join_logo_scp_trial/result';
// 全体の進捗のうち CM 検出が占める割合
const DETECT_WEIGHT = 0.2;

let currentChild = null;
let lastPercent = 0;

const progress = (percent, log) => {
    lastPercent = Math.max(lastPercent, percent);
    console.log(JSON.stringify({ type: 'progress', percent: lastPercent, log: log }));
};

/**
 * 動画情報取得関数
 * @param {string} filePath ファイルパス
 */
const probe = filePath => {
    return new Promise((resolve, reject) => {
        execFile(
            ffprobe,
            ['-v', '0', '-analyzeduration', '100M', '-probesize', '100M', '-show_format', '-show_streams', '-of', 'json', filePath],
            { maxBuffer: 16 * 1024 * 1024 },
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (err) {
                    reject(err);
                }
            },
        );
    });
};

/**
 * "30000/1001" 形式のフレームレートを数値にする
 */
const parseRate = rate => {
    if (typeof rate !== 'string') return null;
    const m = rate.match(/^(\d+)\/(\d+)$/);
    if (m === null || parseInt(m[2], 10) === 0) return null;
    return parseInt(m[1], 10) / parseInt(m[2], 10);
};

/**
 * jlse による CM 検出 (エンコードはしない)
 * 失敗してもチャプター無しでエンコードを続けるため、常に resolve する
 */
const detect = () => {
    return new Promise(resolve => {
        const env = Object.create(process.env);
        env.HOME = '/root';
        const child = spawn('jlse', ['-i', input], { env: env });
        currentChild = child;
        child.stderr.on('data', data => {
            const lines = String(data).split(/[\r\n]+/);
            for (const line of lines) {
                let m = line.match(/Creating\slwi\sindex\sfile\s(\d+)%/);
                if (m !== null) {
                    progress((DETECT_WEIGHT * 0.5 * parseInt(m[1], 10)) / 100, '(1/3) CM検出: インデックス作成 ' + m[1] + '%');
                    continue;
                }
                m = line.match(/^chapter_exe/);
                if (m !== null) {
                    progress(DETECT_WEIGHT * 0.5, '(2/3) CM検出: chapter_exe');
                    continue;
                }
                m = line.match(/logoframe\schecking\s*(\d+)\/(\d+)/);
                if (m !== null && parseInt(m[2], 10) > 0) {
                    progress(DETECT_WEIGHT * (0.5 + (0.5 * parseInt(m[1], 10)) / parseInt(m[2], 10)), '(3/3) CM検出: logoframe');
                }
            }
        });
        child.on('error', err => {
            console.error(err);
            resolve(false);
        });
        child.on('close', code => {
            currentChild = null;
            resolve(code === 0);
        });
    });
};

/**
 * obs_jlscp.txt から ffmetadata 形式のチャプター文字列を作る
 * @param {string} resultDir jlse の結果フォルダ
 * @param {number} fps 映像のフレームレート
 * @param {number} duration 動画長 (秒)
 * @param {number} offsetSec 映像の開始時刻と出力の開始時刻の差 (秒)
 * @return {string|null} チャプターが作れなければ null
 */
const buildChapters = (resultDir, fps, duration, offsetSec) => {
    const file = path.join(resultDir, 'obs_jlscp.txt');
    if (!fs.existsSync(file)) return null;
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        // 例: "   156    604   15  -1    0 :CM"
        const m = line.trim().match(/^(\d+)\s+\d+\s.*:(\S+)$/);
        if (m === null) continue;
        const label = m[2].startsWith('CM') ? 'CM' : '本編';
        // 同じ種類が続く場合は結合する
        if (rows.length > 0 && rows[rows.length - 1].label === label) continue;
        rows.push({ start: parseInt(m[1], 10), label: label });
    }
    if (rows.length === 0) return null;

    let text = ';FFMETADATA1\n';
    for (let i = 0; i < rows.length; i++) {
        const start = i === 0 ? 0 : Math.max(0, Math.round((rows[i].start / fps + offsetSec) * 1000));
        const end = i + 1 < rows.length ? Math.max(0, Math.round((rows[i + 1].start / fps + offsetSec) * 1000)) : Math.round(duration * 1000);
        if (end <= start) continue;
        text += '[CHAPTER]\nTIMEBASE=1/1000\nSTART=' + start + '\nEND=' + end + '\ntitle=' + rows[i].label + '\n';
    }
    return text;
};

(async () => {
    // 進捗計算のために動画の長さ等を取得
    const info = await probe(input);
    const duration = parseFloat(info.format.duration);
    const video = info.streams.find(s => s.codec_type === 'video');
    const fps = (video && parseRate(video.r_frame_rate)) || 30000 / 1001;
    // 音声が映像より先に始まる場合、出力は音声の開始が 0 になるのでその差を補正する
    let offsetSec = 0;
    if (video && video.start_time && info.format.start_time) {
        offsetSec = parseFloat(video.start_time) - parseFloat(info.format.start_time);
        if (!isFinite(offsetSec)) offsetSec = 0;
    }

    // CM 検出
    const detected = await detect();
    const name = path.basename(input, path.extname(input));
    let metaPath = null;
    if (detected) {
        const meta = buildChapters(path.join(JLSE_RESULT_DIR, name), fps, duration, offsetSec);
        if (meta !== null) {
            metaPath = path.join(os.tmpdir(), 'chapters-' + process.pid + '.ffmeta');
            fs.writeFileSync(metaPath, meta);
        }
    }
    if (metaPath === null) {
        console.error('CM検出に失敗したため、チャプター無しでエンコードします');
    }

    // ffmpeg の引数
    const args = ['-y'];
    // input 設定
    Array.prototype.push.apply(args, ['-analyzeduration', '100M', '-probesize', '100M', '-i', input]);
    if (metaPath !== null) {
        Array.prototype.push.apply(args, ['-i', metaPath]);
    }
    // ビデオストリーム設定
    Array.prototype.push.apply(args, ['-map', '0:v:0', '-c:v', 'libx264']);
    // インターレス解除
    Array.prototype.push.apply(args, ['-vf', videoFilter]);
    // オーディオストリーム設定
    if (isDualMono) {
        Array.prototype.push.apply(args, [
            '-filter_complex',
            'channelsplit[FL][FR]',
            '-map', '[FL]',
            '-map', '[FR]',
            '-metadata:s:a:0', 'language=jpn',
            '-metadata:s:a:1', 'language=eng',
        ]);
    } else {
        Array.prototype.push.apply(args, ['-map', '0:a']);
    }
    Array.prototype.push.apply(args, ['-c:a', 'libopus', '-strict', '-2']);
    // 字幕(ARIB)は MKV に入れない
    Array.prototype.push.apply(args, ['-sn']);
    // チャプター設定
    if (metaPath !== null) {
        Array.prototype.push.apply(args, ['-map_metadata', '1', '-map_chapters', '1']);
    }
    // 品質設定
    Array.prototype.push.apply(args, ['-preset', preset, '-crf', crf]);
    Array.prototype.push.apply(args, ['-maxrate:v', '2.5M']);
    Array.prototype.push.apply(args, ['-bufsize:v', 2621440]); // 1024*1024*2.5
    Array.prototype.push.apply(args, ['-aspect', '16:9', '-f', 'matroska', '-ar', '48000', '-ab', audioBitrate, '-ac', '2']);
    // 出力ファイル
    Array.prototype.push.apply(args, [output]);

    const child = spawn(ffmpeg, args);
    currentChild = child;
    child.stderr.on('data', data => {
        const lines = String(data).split(/[\r\n]+/);
        for (const str of lines) {
            if (!str.startsWith('frame')) continue;
            const time = str.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (time === null) continue;
            const current = parseInt(time[1], 10) * 3600 + parseInt(time[2], 10) * 60 + parseFloat(time[3]);
            const percent = DETECT_WEIGHT + (1 - DETECT_WEIGHT) * Math.min(current / duration, 1);
            progress(percent, str.trim());
        }
    });
    child.on('error', err => {
        console.error(err);
        throw new Error(err);
    });
    child.on('close', code => {
        if (metaPath !== null) {
            try {
                fs.unlinkSync(metaPath);
            } catch (e) {
                // 一時ファイルの削除失敗は無視する
            }
        }
        process.exit(code === null ? 1 : code);
    });
    process.on('SIGINT', () => {
        if (currentChild !== null) currentChild.kill('SIGINT');
    });
})();
