/* ============================================================================
 * Surgeon Kernel PA 0.3    Файл: bios/post/post.js
 * ----------------------------------------------------------------------------
 * Текстовый POST в духе AMIBIOS: шапка с логотипом, лента инициализации,
 * счётчик памяти, сплэш с подсказками <Del> и <F11>.
 *
 * Наружу отдаёт:
 *   TPABKA_REGISTRY  — реестр железа: пишет POST, читают Setup и ядро;
 *   SurgeonPerf      — часы и ускорение: разгон быстрее гоняет POST и GRUB;
 *   SurgeonDiskReady — накопитель просканирован, бутлоадеру можно грузиться;
 *   TPABKA_PROCESSES — таблица процессов, чистится на входе в BIOS.
 *
 * Setup не открывается с одного нажатия: <Del> надо долбить DEL_PRESSES раз и
 * только на фазе логотипа — пока идёт лента, клавиши молчат.
 *
 * Перед передачей эстафеты POST проверяет машину (см. finishPOST):
 *   грузить нечего        -> чёрный экран "No Bootable Device";
 *   обязательные пункты   -> ошибка на экране и возврат в Setup через 2 сек;
 *   разгон за лимитами    -> артефакты, ошибка и возврат в Setup через 2 сек.
 *
 * API: SurgeonPost.init() / runPOST() / destroy() / platform() / perf()
 *
 * Куда уходит управление:
 *   <Del> x5        -> window.SurgeonClickBios.init()   (только на фазе лого)
 *   таймаут / <F11> -> событие 'bios_complete', на него подписан GRUB
 * ========================================================================== */
(function (window, document) {
    'use strict';

    /* --- 1. Тайминги, клавиши, лимиты -------------------------------------- */
    var PA_VERSION    = 'PA 0.3';
    var CONTAINER_ID  = 'surgeon-post';
    var ERROR_ID      = 'surgeon-post-error';
    var LOGO_WORD     = 'SURGEON';
    var LINE_DELAY    = 110;      // мс между строками POST (IDE растягивает на треть)
    var RAM_MAX_MB    = 4096;
    var RAM_STEP_MB   = 256;
    var RAM_TICK_MS   = 30;
    var LOG_LIMIT     = 18;       // строк в окне: лишние уползают вверх
    var SPLASH_DELAY  = 1500;     // пауза после последней строки POST
    var SETUP_TIMEOUT = 4000;     // сколько ждём <Del>, потом грузимся дальше
    var DEL_PRESSES   = 5;        // столько нажатий <Del> открывают Setup
    var SETUP_RETURN_MS = 2000;   // ошибка проверки: держим экран и уходим в Setup

    var KEY_DELETE = 46;
    var KEY_F11    = 122;

    /* --- 1a. Ключи хранилища: их читают бутлоадер и ядро ------------------- */
    var DISK_KEY     = 'surgeon_virtual_disk';
    var DISK_LABEL   = 'SURGEON_VDFS_SSD';
    var DISK_SIZE_MB = 524288;    // 512 GB — как на наклейке корпуса
    var PART_SIZE_MB = 262144;    // по 256 GB на раздел
    var FS_PROTECTED = 'pww13';   // защищённая ФС: /core/ и /drivers/
    var FS_USER      = 'vdfs';    // расширяемая ФС: /home/ и /Versions/Apps/

    /* Паспорт железа: цифры нарисованы, структура настоящая. */
    var CPU_MODEL     = 'GenuineSurgeon(R) Virtual Core Processor @ 3.60GHz';
    var CPU_SPEED_MHZ = 3600;
    var RAM_TOTAL_MB  = 4096;
    var BOARD_NAME    = 'Surgeon Z990 (VDFS Bridge)';
    var USB_DEVICES   = ['USB Keyboard (port 3)', 'USB Mouse (port 4)'];

    /* --- 2. Низкоуровневый слой: реестр, процессы, виртуальный диск -------- */

    /* Шаблон реестра: заливается до первой строки POST, дальше только дополняется. */
    function registryDefaults() {
        return {
            hardware: {
                cpu:     { status: 'OK', microcode: '0x1A', overclocked: false },
                video:   { driver: '[NOT_INITIALIZED]', mode: 'Standard Text Mode', resolution: null },
                mouse:   { driver: '[NOT_INITIALIZED]', irq: 12 },
                usb_bus: { driver: '[NOT_INITIALIZED]', devices: [] },
                acpi:    { driver: '[NOT_INITIALIZED]', power_state: 'S0' },
                storage: { driver: '[NOT_INITIALIZED]', device: DISK_LABEL, partitions: [], ready: false }
            },
            system_flags: {
                is_safe_mode: false,
                kernel_ring: 0
            }
        };
    }

    /* Реестр создаётся один раз: дальше любой модуль только читает ветки. */
    function ensureRegistry() {
        var base = registryDefaults();
        var reg, group, key;

        window.TPABKA_REGISTRY = window.TPABKA_REGISTRY || base;
        reg = window.TPABKA_REGISTRY;

        /* После factory-reset реестр бывает обрезан — достраиваем. */
        for (group in base) {
            if (!Object.prototype.hasOwnProperty.call(base, group)) { continue; }
            if (!reg[group] || typeof reg[group] !== 'object') { reg[group] = {}; }

            for (key in base[group]) {
                if (!Object.prototype.hasOwnProperty.call(base[group], key)) { continue; }
                if (typeof reg[group][key] === 'undefined') {
                    reg[group][key] = base[group][key];
                }
            }
        }
        return reg;
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function readJSON(key, fallback) {
        try {
            var raw = window.localStorage.getItem(key);
            if (!raw) { return fallback; }

            var parsed = JSON.parse(raw);
            return parsed === null ? fallback : parsed;
        } catch (error) {
            return fallback;      // приватный режим или мусор в хранилище
        }
    }

    function writeJSON(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            // не сохранилось — BIOS живёт в памяти
        }
    }

    /* --- 2c. Флаги NVRAM: те же ключи, что пишет Click BIOS ---------------- */
    /* SATA [IDE] роняет шину до 70%, Legacy USB гасит клавиатуру, Secure Boot
     * оставляет только подписанные сборки, разгон задаёт частоты. */
    var SATA_KEY   = 'surgeon_bios_storage';
    var USB_KEY    = 'surgeon_bios_usb';
    var SECURE_KEY = 'surgeon_bios_security';
    var OVERHEAT_KEY = 'surgeon_bios_overheat';   // журнал перегрева от Setup
    var OC_KEY       = 'surgeon_bios_oc';         // { voltage, multiplier }
    var MEMORY_KEY   = 'surgeon_bios_memory';     // XMP или ручные частоты DRAM
    var IDE_THROTTLE = 0.7;       // io_throttle из Click BIOS

    /* Снимок берётся один раз за прогон POST: дальше только по памяти. */
    var platform = null;

    function readPlatform() {
        var storage  = readJSON(SATA_KEY, null);
        var usb      = readJSON(USB_KEY, null);
        var security = readJSON(SECURE_KEY, null);
        var ide      = !!(storage && storage.sata_mode === 'IDE');

        return {
            sataMode:   ide ? 'IDE' : 'AHCI',
            ioThrottle: ide ? IDE_THROTTLE : 1,
            legacyUsb:  !(usb && usb.legacy_usb === false),
            secureBoot: !!(security && security.secure_boot === true)
        };
    }

    function ensurePlatform() {
        if (!platform) { platform = readPlatform(); }
        return platform;
    }

    /* --- 2d. Разгон: часы и ускорение машины ------------------------------ */
    /* Скорость берётся из NVRAM: множитель и напряжение CPU плюс частота
     * памяти. IDE тормозит шину, перегрев режет частоту до 70% — как на железе. */
    var BASE_CLOCK   = 3600;      // МГц на штатных 36x / 1.032V / DDR4-3200
    var BASE_RATIO   = 36;
    var BASE_VOLTAGE = 1.032;
    var BASE_MEM_MHZ = 3200;
    var SPEED_LIMIT  = 1.8;       // выше не гонится ни один профиль
    var OVERHEAT_THROTTLE = 0.7;  // перегрев: минус 30% к частоте

    function readOCProfile() {
        var oc = readJSON(OC_KEY, null);

        return {
            ratio:   (oc && typeof oc.multiplier === 'number') ? oc.multiplier : BASE_RATIO,
            voltage: (oc && typeof oc.voltage === 'number') ? oc.voltage : BASE_VOLTAGE
        };
    }

    function readMemoryProfile() {
        var mem = readJSON(MEMORY_KEY, null);

        return {
            xmp: (mem && typeof mem.xmp === 'string') ? mem.xmp : 'Disabled',
            mhz: (mem && typeof mem.freq_mhz === 'number') ? mem.freq_mhz : BASE_MEM_MHZ,
            cl:  (mem && typeof mem.cl === 'number') ? mem.cl : 16
        };
    }

    /* Перегрев спрашиваем у Click BIOS: лимиты живут в одном месте. */
    function overheatNow() {
        var api = window.SurgeonOverheat;
        var live;

        if (api && typeof api.state === 'function') {
            live = api.state();
            return { active: live.active === true, text: live.text || '' };
        }
        return { active: false, text: '' };
    }

    function perfText(snap) {
        var parts = ['CPU ' + snap.cpuMHz + 'MHz', 'DDR4-' + snap.memoryMHz +
            ' @ ' + snap.memoryClock + 'MHz'];
        var boost = Math.round((snap.speed - 1) * 100);

        if (snap.memoryXmp !== 'Disabled') { parts.push('XMP ' + snap.memoryXmp); }
        parts.push(boost > 0 ? 'boost +' + boost + '%' : 'штатный режим');

        if (snap.throttled) { parts.push('CPU THROTTLED 70%'); }
        return parts.join('  ·  ');
    }

    function perfSnapshot() {
        var oc     = readOCProfile();
        var mem    = readMemoryProfile();
        var broken = overheatNow();
        var cpuMHz = Math.round(BASE_CLOCK * (oc.ratio / BASE_RATIO) *
            (1 + (oc.voltage - BASE_VOLTAGE) * 0.5));
        var speed  = (cpuMHz / BASE_CLOCK) * (1 + (mem.mhz - BASE_MEM_MHZ) / BASE_MEM_MHZ * 0.5);
        var snap;

        if (broken.active) { speed *= OVERHEAT_THROTTLE; }
        speed = Math.min(Math.max(speed, 0.4), SPEED_LIMIT);

        snap = {
            ratio:       oc.ratio,
            voltage:     oc.voltage,
            memoryXmp:   mem.xmp,
            memoryMHz:   mem.mhz,
            memoryCL:    mem.cl,
            cpuMHz:      cpuMHz,
            memoryClock: Math.round(mem.mhz / 2),
            speed:       Math.round(speed * 1000) / 1000,
            throttled:   broken.active,
            reason:      broken.text,
            text:        ''
        };
        snap.text = perfText(snap);
        return snap;
    }

    function perfSpeed() {
        return perfSnapshot().speed;
    }

    /* Разгон гонит ленту POST: строка идёт во столько раз быстрее, во сколько
     * раз железо быстрее штатного. */
    function stepDelay() {
        return Math.round(LINE_DELAY / ensurePlatform().ioThrottle / perfSpeed());
    }

    function ramTickMs() {
        return Math.max(6, Math.round(RAM_TICK_MS / perfSpeed()));
    }

    /* --- 2e. Чек-лист Setup: обязательные пункты перед загрузкой ---------- */
    /* Список живёт в Click BIOS (SurgeonSetupCheck): POST только спрашивает. */
    function setupCheck() {
        var api     = window.SurgeonSetupCheck;
        var pending;

        if (!api || typeof api.pending !== 'function') { return null; }

        pending = api.pending();
        if (!isArray(pending)) { pending = []; }

        return {
            pending: pending,
            total: (typeof api.total === 'function') ? api.total() : pending.length
        };
    }

    function setupCheckText() {
        var check  = setupCheck();
        var labels = [];
        var i;

        if (!check) { return '[Click BIOS не подключён]'; }
        if (check.pending.length === 0) {
            return 'all ' + check.total + ' required item(s) set';
        }

        for (i = 0; i < check.pending.length; i++) { labels.push(check.pending[i].label); }

        return (check.total - check.pending.length) + '/' + check.total + ' done' +
            '        PENDING: ' + labels.join('; ');
    }

    /* --- 2a. Таблица процессов симулятора --------------------------------- */
    /* Всё из прошлого запуска обязано умереть, иначе чужие интервалы живут дальше. */
    function resetProcessTable() {
        var old    = window.TPABKA_PROCESSES;
        var killed = 0;
        var entry, i;

        if (isArray(old)) {
            for (i = 0; i < old.length; i++) {
                entry = old[i];
                if (!entry) { continue; }

                /* Драйверы кладут сюда свои kill()/cancel(). */
                if (typeof entry.kill === 'function') {
                    try { entry.kill(); killed++; } catch (error) { /* уже мёртв */ }
                } else if (typeof entry.cancel === 'function') {
                    try { entry.cancel(); killed++; } catch (error) { /* уже мёртв */ }
                }

                if (typeof entry.interval === 'number') { window.clearInterval(entry.interval); killed++; }
                if (typeof entry.timeout === 'number')  { window.clearTimeout(entry.timeout);  killed++; }
            }
        }

        window.TPABKA_PROCESSES = [];
        return killed;
    }

    /* --- 2b. Виртуальный диск (JSON-ФС) ----------------------------------- */
    /* Разметка: защищённый pww13 под ядро и расширяемый vdfs под пользователя. */
    function diskLayout() {
        return {
            label:       DISK_LABEL,
            interface:   'VDFS-BRIDGE',
            fs_revision: PA_VERSION,
            sector_size: 512,
            size_mb:     DISK_SIZE_MB,
            created:     new Date().toISOString(),
            partitions: [
                {
                    id:           'pww13-core',
                    fs:           FS_PROTECTED,
                    label:        'SURGEON_CORE',
                    size_mb:      PART_SIZE_MB,
                    status:       'OK',
                    bootable:     true,
                    protected:    true,
                    mount_points: ['/core/', '/drivers/'],
                    directories:  ['/core/', '/drivers/']
                },
                {
                    id:           'vdfs-home',
                    fs:           FS_USER,
                    label:        'SURGEON_HOME',
                    size_mb:      PART_SIZE_MB,
                    status:       'OK',
                    bootable:     false,
                    protected:    false,
                    mount_points: ['/home/', '/Versions/Apps/'],
                    directories:  ['/home/', '/Versions/Apps/']
                }
            ],
            boot: { device: DISK_LABEL, partition: 'pww13-core' }
        };
    }

    /* Физический скан накопителя: находим готовую разметку или пишем новую. */
    function ensureVirtualDisk() {
        var disk    = readJSON(DISK_KEY, null);
        var created = false;
        var reg, parts, part, i;

        if (!disk || typeof disk !== 'object' || !isArray(disk.partitions) ||
            disk.partitions.length === 0) {
            disk = diskLayout();
            writeJSON(DISK_KEY, disk);
            created = true;
        }

        reg   = ensureRegistry();
        parts = [];

        for (i = 0; i < disk.partitions.length; i++) {
            part = disk.partitions[i];
            parts.push({
                id:           part.id,
                fs:           part.fs,
                mount_points: isArray(part.mount_points) ? part.mount_points.slice() : []
            });
        }

        reg.hardware.storage.driver     = '[VDFS_BRIDGE]';
        reg.hardware.storage.device     = disk.label;
        reg.hardware.storage.partitions = parts;
        reg.hardware.storage.ready      = true;

        window.SurgeonDiskInfo = disk;      // ядру и GRUB: живой объект разметки

        if (window.SurgeonDiskReady !== true) {
            window.SurgeonDiskReady = true;     // зелёный свет бутлоадеру
            console.log('[BIOS] Virtual disk ready: ' + disk.label + ' (' +
                (created ? 'new layout written' : 'existing layout mounted') + ')');
            document.dispatchEvent(new CustomEvent('surgeon_disk_ready'));
        }

        return { disk: disk, created: created };
    }

    /* Таблица монтирования одной строкой — для ленты POST и панели Setup. */
    function partitionTableText(disk) {
        var text = '';
        var i, part;

        for (i = 0; i < disk.partitions.length; i++) {
            part = disk.partitions[i];
            text += (i ? '  |  ' : '') + part.fs + ' [' + part.status + '] ' +
                part.mount_points.join(' ');
        }
        return text;
    }

    /* --- 3. Блочный шрифт 5x6 для логотипа --------------------------------- */
    var LOGO_FONT = {
        S: [' █████', '██    ', ' █████', '     ██', '██████'],
        U: ['██  ██', '██  ██', '██  ██', '██  ██', ' ████ '],
        R: ['█████ ', '██  ██', '█████ ', '██ ██ ', '██  ██'],
        G: [' █████', '██    ', '██ ███', '██  ██', ' ████ '],
        E: ['██████', '██    ', '█████ ', '██    ', '██████'],
        O: [' ████ ', '██  ██', '██  ██', '██  ██', ' ████ '],
        N: ['██  ██', '███ ██', '██████', '██ ███', '██  ██']
    };

    function buildLogoArt(word) {
        var rows = ['', '', '', '', ''];
        var i, r, glyph;

        for (i = 0; i < word.length; i++) {
            glyph = LOGO_FONT[word.charAt(i)];
            if (!glyph) { continue; }
            for (r = 0; r < rows.length; r++) {
                rows[r] += (i > 0 ? ' ' : '') + glyph[r];
            }
        }
        return rows.join('\n');
    }

    var LOGO_ART = buildLogoArt(LOGO_WORD);

    /* --- 4. Ленты экрана --------------------------------------------------- */
    var HEAD_LINES = [
        'AMIBIOS (C) 2026 American Megatrends, Inc.',
        'SURGEON BOARD ACPI BIOS Revision 0101',
        'SURGEON CLICK BIOS 5  \u00b7  ' + PA_VERSION + '  \u00b7  10/10/2026'
    ];

    /* --- 4a. Лента POST собирается на живых данных реестра ---------------- */
    /* Элемент ленты: текст, функция (считается в момент вывода), пустая строка,
     * счётчик памяти или отдельный шаг инициализации железа. */
    function buildPostScript() {
        var reg  = ensureRegistry();
        var hw   = reg.hardware;
        var disk = readJSON(DISK_KEY, null);
        var firstFs = (disk && isArray(disk.partitions) && disk.partitions.length)
            ? disk.partitions[0].fs : FS_PROTECTED;

        return [
            { text: 'CPU : ' + CPU_MODEL },
            { text: function () {
                return 'Status : ' + hw.cpu.status + '        Microcode : ' + hw.cpu.microcode +
                    '        Overclock : ' + (hw.cpu.overclocked ? 'ON' : 'OFF');
            } },
            { text: function () {
                var perf  = perfSnapshot();
                var boost = Math.round((perf.speed - 1) * 100);

                return 'Speed : ' + perf.cpuMHz + 'MHz (base ' + CPU_SPEED_MHZ + 'MHz, ' +
                    (boost > 0 ? 'OC boost +' + boost + '%' : 'stock') +
                    ')        Count : 1 Core / 2 Threads';
            } },
            { text: function () {
                return 'Cache : 512KB L2 + 8MB L3        Kernel Ring : ' + reg.system_flags.kernel_ring;
            } },
            { text: 'Chipset : ' + BOARD_NAME + ' Rev. 21' },
            { text: 'BIOS Date : 10/10/2026        Rev. 0101 (UEFI 2.7)' },
            { text: function () {
                var perf = perfSnapshot();

                return 'Total Memory : ' + RAM_TOTAL_MB + 'MB DDR4-' + perf.memoryMHz + ' @ ' +
                    perf.memoryClock + 'MHz (' + perf.memoryXmp + ')';
            } },
            { text: function () {
                return 'VGA : ' + hw.video.driver + '        Mode : ' + hw.video.mode;
            } },
            { text: function () {
                return 'Pointing : ' + hw.mouse.driver + '        IRQ : ' + hw.mouse.irq;
            } },
            { text: function () {
                return 'Process Table : 0 active (' + staleProcessesKilled +
                    ' stale process(es) killed, simulator RAM cleared)';
            } },
            { blank: true },
            { run: stepUsbControllers },
            { text: 'Auto-Detecting SATA Port 0 ... ' + DISK_LABEL + ' 512GB' },
            { text: 'Auto-Detecting SATA Port 1 ... SURGEON_OPTICAL_DVD-RW' },
            { text: 'Detecting ATA/ATAPI Devices .. 3 Devices Found' },
            { text: function () {
                var p = ensurePlatform();
                return 'SATA Mode : ' + p.sataMode + (p.sataMode === 'IDE'
                    ? '        (compatibility, I/O throttled to 70%)'
                    : '            (native, full speed)');
            } },
            { text: function () {
                var p = ensurePlatform();
                return 'Legacy USB : ' + (p.legacyUsb ? 'Enabled' : 'Disabled') +
                    '       Secure Boot : ' +
                    (p.secureBoot ? 'Enabled (signed builds only)' : 'Disabled');
            } },
            { text: function () {
                return 'Overclocking : ' + perfSnapshot().text;
            } },
            { text: function () {
                return 'Setup Checklist : ' + setupCheckText();
            } },
            { text: 'PCI Express x16 Link Training .. x16 (Gen3)' },
            { run: stepVideo },
            { memtest: true },
            { blank: true },
            { run: stepVirtualDisk },
            { run: stepAcpi },
            { text: function () {
                return 'Drivers : VGA ' + hw.video.driver + '  USB ' + hw.usb_bus.driver +
                    '  ACPI ' + hw.acpi.driver + '  STORAGE ' + hw.storage.driver;
            } },
            { text: 'Verifying DMI Pool Data ......' },
            { text: 'VDFS: boot device selected -> ' + DISK_LABEL + ' (' + firstFs + ')' },
            { text: 'BIOS POST complete. Handing over to boot loader.' }
        ];
    }

    function lineText(item) {
        return (typeof item.text === 'function') ? item.text() : item.text;
    }

    /* --- 5. Состояние ------------------------------------------------------ */
    var container  = null;    // корневая коробка #surgeon-post
    var logEl      = null;    // лента строк инициализации
    var keyHandler = null;
    var setupTimer = null;
    var runToken   = 0;       // номер прогона: прошлый POST сам себя останавливает
    var delPresses = 0;       // сколько раз уже долбили <Del>
    var delProgressEl = null; // строка с прогрессом на сплэше
    var splashVisible = false; // лого на экране: только тогда клавиши видны
    var staleProcessesKilled = 0;   // сколько процессов прибито на входе в BIOS
    var thermalNoticeEl = null;     // строка аварийного режима на сплэше
    var thermalActive   = false;    // артефакты включил именно POST

    /* --- 6. Мелкие хелперы ------------------------------------------------- */
    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (typeof text === 'string') { node.textContent = text; }
        return node;
    }

    function pad(value, size) {
        var text = String(value);
        while (text.length < size) { text = '0' + text; }
        return text;
    }

    function isStale(token) {
        return token !== runToken;
    }

    /* Лента не растёт: лишняя строка уезжает вверх. */
    function trimLog() {
        if (!logEl) { return; }
        while (logEl.childNodes.length > LOG_LIMIT) {
            logEl.removeChild(logEl.firstChild);
        }
    }

    function printLine(text) {
        if (!logEl) { return null; }

        var line = el('div', 'post-line', text);
        logEl.appendChild(line);
        trimLog();
        return line;
    }

    function printBlank() {
        if (!logEl) { return; }
        logEl.appendChild(el('div', 'post-blank'));
        trimLog();
    }

    /* --- 7. Сборка экрана POST --------------------------------------------- */
    function buildHead() {
        var head  = el('div', 'post-head');
        var texts = el('div', 'post-head-text');
        var brand = el('div', 'post-head-brand');
        var i;

        for (i = 0; i < HEAD_LINES.length; i++) {
            texts.appendChild(el('div',
                'post-head-line' + (i === 0 ? ' post-head-title' : ''), HEAD_LINES[i]));
        }

        brand.appendChild(el('pre', 'post-head-art', LOGO_ART));
        brand.appendChild(el('div', 'post-head-caption', 'CLICK BIOS 5  \u00b7  ' + PA_VERSION));

        head.appendChild(texts);
        head.appendChild(brand);
        return head;
    }

    function buildContainer() {
        var old = document.getElementById(CONTAINER_ID);
        if (old && old.parentNode) { old.parentNode.removeChild(old); }

        container = el('div', 'post-text');
        container.id = CONTAINER_ID;

        var screen = el('div', 'post-screen');
        screen.appendChild(buildHead());

        logEl = el('div', 'post-log');
        screen.appendChild(logEl);
        container.appendChild(screen);

        document.body.appendChild(container);
        return container;
    }

    /* --- 8. Счётчик памяти: 0 -> 4096 MB с шагом 256 ----------------------- */
    function checkNVRAM(token) {
        return new Promise(function (resolve) {
            var row     = el('div', 'post-line');
            var value   = el('span', 'post-value', pad(0, 4));
            var current = 0;
            var timer   = null;

            row.appendChild(el('span', 'post-ok', 'Memory Test : '));
            row.appendChild(value);
            row.appendChild(el('span', 'post-ok', ' MB'));

            if (logEl) {
                logEl.appendChild(row);
                trimLog();
            }

            timer = window.setInterval(function () {
                if (isStale(token) || !row.parentNode) {
                    window.clearInterval(timer);
                    resolve();
                    return;
                }

                current += RAM_STEP_MB;
                value.textContent = pad(current, 4);

                if (current >= RAM_MAX_MB) {
                    window.clearInterval(timer);
                    value.textContent = pad(RAM_MAX_MB, 4);
                    row.appendChild(el('span', 'post-ok', '  OK'));
                    resolve();
                }
            }, ramTickMs());
        });
    }

    /* --- 8a. Шаги инициализации: пишут в реестр и в ленту ------------------ */
    async function stepUsbControllers(token) {
        var hw = ensureRegistry().hardware;

        hw.usb_bus.driver  = '[XHCI_LEGACY]';
        hw.usb_bus.devices = USB_DEVICES.slice();

        printLine('Initializing USB Controllers .. ' + hw.usb_bus.driver + ' Done');
        await sleep(stepDelay());
        if (isStale(token)) { return; }

        printLine('USB Device(s) : ' + hw.usb_bus.devices.length + ' -> ' + hw.usb_bus.devices.join(', '));
        await sleep(stepDelay());
        if (isStale(token)) { return; }

        hw.mouse.driver = '[PS2_LEGACY_MOUSE]';
        printLine('Pointing Device : ' + hw.mouse.driver + ' on IRQ ' + hw.mouse.irq);
    }

    async function stepVideo(token) {
        var hw = ensureRegistry().hardware;

        hw.video.driver     = '[VESA_VBE_3.0]';
        hw.video.mode       = 'VBE 1024x768x32';
        hw.video.resolution = { width: 1024, height: 768, bpp: 32 };

        if (isStale(token)) { return; }
        printLine('VGA BIOS : ' + hw.video.driver + '  Mode ' + hw.video.mode);
    }

    /* Скан накопителя: разметка и таблица монтирования. */
    async function stepVirtualDisk(token) {
        var scan = ensureVirtualDisk();
        var disk = scan.disk;
        var i, part;

        printLine('Scanning virtual disk .. ' + disk.label + ' (' + disk.size_mb + ' MB, ' +
            disk.partitions.length + ' partitions)');
        await sleep(stepDelay());
        if (isStale(token)) { return; }

        for (i = 0; i < disk.partitions.length; i++) {
            part = disk.partitions[i];
            printLine('  ' + part.fs + ' : ' + part.mount_points.join(' ') + ' .. ' + part.status +
                ' (' + part.size_mb + ' MB' + (part.protected ? ', protected' : ', writable') + ')');
            await sleep(stepDelay());
            if (isStale(token)) { return; }
        }

        printLine('Disk layout : ' + (scan.created ? 'new partition table written' :
            'existing layout mounted'));
        await sleep(stepDelay());
        if (isStale(token)) { return; }

        printLine('Mount Table : ' + partitionTableText(disk));
    }

    async function stepAcpi(token) {
        var hw = ensureRegistry().hardware;

        hw.acpi.driver = '[ACPI_2.0]';

        if (isStale(token)) { return; }
        printLine('ACPI : ' + hw.acpi.driver + '  RSDP @ 0x000F0000  Power State : ' + hw.acpi.power_state);
    }

    /* --- 9. Прогон POST --------------------------------------------------- */
    async function runPOST() {
        var token  = runToken;
        var script = buildPostScript();

        splashVisible = false;      // логотипа пока нет
        var item, i;

        for (i = 0; i < script.length; i++) {
            if (isStale(token)) { return; }

            item = script[i];

            if (item.run) {
                await item.run(token);
            } else if (item.memtest) {
                await checkNVRAM(token);
            } else if (item.blank) {
                printBlank();
            } else {
                printLine(lineText(item));
            }

            if (isStale(token)) { return; }
            await sleep(stepDelay());
        }

        if (isStale(token)) { return; }
        await sleep(SPLASH_DELAY);

        if (isStale(token)) { return; }

        showSplash();
    }

    /* --- 9a. Перегрев с прошлого запуска ---------------------------------- */
    /* Журнал пишет Click BIOS. armed = настройки сохранены (Save & Exit):
     * без сохранения машина грузится чисто, артефактов нет. */
    function thermalRecord() {
        if (window.SurgeonOverheat && typeof window.SurgeonOverheat.record === 'function') {
            return window.SurgeonOverheat.record();
        }
        return readJSON(OVERHEAT_KEY, null);
    }

    function thermalStatus() {
        var api = window.SurgeonOverheat;

        if (api && typeof api.state === 'function') { return api.state(); }
        return { active: false, text: '' };
    }

    function thermalDetails(status) {
        var parts = (status.text || '').split('  \u00b7  ');
        var out   = [];
        var i;

        for (i = 0; i < parts.length; i++) {
            if (parts[i] !== '') { out.push('  ' + parts[i]); }
        }
        return out.length ? out : ['  OC profile rejected'];
    }

    function applyThermalOverride(root) {
        var record = thermalRecord();
        var status = thermalStatus();
        var text;

        if (!record || record.armed !== true || status.active !== true) { return false; }

        if (window.SurgeonOverheat && typeof window.SurgeonOverheat.start === 'function') {
            window.SurgeonOverheat.start(root || container);
            thermalActive = true;
        }

        text = status.text || record.reason || 'OC profile rejected';

        if (thermalNoticeEl) {
            thermalNoticeEl.textContent = 'EMERGENCY THERMAL OVERRIDE: ' + text +
                '  \u00b7  искажения экрана включены  \u00b7  сброс разгона: <Del> x' + DEL_PRESSES +
                ' -> Setup -> Ctrl+Alt+R (XMP и Boot Priority сохранятся)';
        }

        console.warn('[POST] Thermal override from NVRAM (armed): ' + text);
        return true;
    }

    /* --- 9b. Экран ошибки: машина не поехала ------------------------------ */
    /* Показываем причину и через SETUP_RETURN_MS уходим в Click BIOS:
     * починить настройки можно только там. */
    var errorLayer = null;
    var errorTimer = null;

    function removeErrorScreen() {
        if (errorTimer !== null) {
            window.clearTimeout(errorTimer);
            errorTimer = null;
        }
        if (errorLayer && errorLayer.parentNode) {
            errorLayer.parentNode.removeChild(errorLayer);
        }
        errorLayer = null;
    }

    function showErrorScreen(title, details) {
        var layer, box, i;

        removeErrorScreen();

        layer    = el('div', 'post-error-screen');
        layer.id = ERROR_ID;
        box      = el('div', 'post-error-box');

        box.appendChild(el('div', 'post-error-title',
            'SURGEON POST  \u00b7  ' + PA_VERSION + '  \u00b7  SYSTEM CHECK FAILED'));
        box.appendChild(el('div', 'post-error-head', title));

        for (i = 0; i < details.length; i++) {
            box.appendChild(el('div', 'post-error-line', details[i]));
        }

        box.appendChild(el('div', 'post-error-foot', 'Returning to Click BIOS Setup in ' +
            (SETUP_RETURN_MS / 1000) + ' s ...'));

        layer.appendChild(box);
        document.body.appendChild(layer);
        errorLayer = layer;

        console.error('[BIOS] POST check failed: ' + title + ' -> ' + details.join(' | '));

        errorTimer = window.setTimeout(function () {
            errorTimer = null;
            teardown();
            launchSetup();
        }, SETUP_RETURN_MS);
    }

    /* Остановка с ошибкой: пункты чек-листа или строки термозащиты.
     * keepArtifacts — перегрев видно и на экране ошибки. */
    function haltToSetup(title, items, keepArtifacts) {
        var details = [];
        var i, item;

        for (i = 0; i < items.length; i++) {
            item = items[i];
            details.push(typeof item === 'string' ? item :
                '  ' + item.label + ' : ' + item.value + '  ->  ' + item.fix);
        }
        if (details.length === 0) { details.push('  (reason unknown)'); }

        showErrorScreen(title, details);

        if (keepArtifacts) { applyThermalOverride(errorLayer); }
    }

    /* --- 10. Фаза 2: сплэш -------------------------------------------------- */
    function buildSplash() {
        var frame = el('div', 'post-splash-frame');

        frame.appendChild(el('pre', 'post-art', LOGO_ART));

        var logo = el('div', 'post-logo');
        logo.appendChild(el('span', 'post-logo-brand', 'SURGEON'));
        logo.appendChild(document.createTextNode(' '));
        logo.appendChild(el('span', 'post-logo-product', 'CLICK BIOS 5'));
        frame.appendChild(logo);

        frame.appendChild(el('div', 'post-splash-sub',
            PA_VERSION + '  \u00b7  BIOS Rev. 0101  \u00b7  10/10/2026  \u00b7  ' +
            '(C) 2026 Surgeon Technologies, Inc.'));

        /* Часы машины: разгон видно на логотипе, до всякой загрузки. */
        frame.appendChild(el('div', 'post-splash-perf', perfSnapshot().text));

        return frame;
    }

    function showSplash() {
        var hint, box;

        if (!container) { return; }

        container.innerHTML = '';
        container.classList.remove('post-text');
        container.classList.add('post-splash');
        container.appendChild(buildSplash());

        logEl         = null;    // ленты POST больше нет
        delPresses    = 0;       // на лого счёт идёт с нуля
        delProgressEl = null;

        hint = el('div', 'post-splash-hint');
        box  = el('div', 'post-hint-box');

        box.appendChild(el('div', 'post-hint',
            'Press <Del> x' + DEL_PRESSES + ' to run BIOS Setup, <F11> to run Boot Menu'));
        delProgressEl = el('div', 'post-hint-progress', '');
        box.appendChild(delProgressEl);

        hint.appendChild(box);
        container.appendChild(hint);

        /* Перегрев не лечится перезагрузкой: журнал NVRAM помнит прошлый запуск. */
        thermalNoticeEl = el('div', 'post-thermal', '');
        container.appendChild(thermalNoticeEl);
        applyThermalOverride();

        /* Лого на экране: только теперь клавиши BIOS видны. */
        splashVisible = true;
        startSetupWindow();
    }

    /* Окно для <Del>: не успел — грузимся дальше. */
    function startSetupWindow() {
        setupTimer = window.setTimeout(function () {
            teardown();
            finishPOST();
        }, SETUP_TIMEOUT);
    }

    /* --- 11. Перехват <Del> и <F11> --------------------------------------- */
    /* <Del> надо долбить, как на живой плате, и только на фазе лого. Пока идёт
     * лента, клавиши молчат — но глушатся всегда, иначе браузер уйдёт в полный
     * экран по <F11>. */
    function armSetupInterrupt() {
        keyHandler = function (event) {
            var code  = event.keyCode || event.which;
            var key   = event.key || '';
            var isDel = (code === KEY_DELETE || key === 'Delete');
            var isF11 = (code === KEY_F11 || key === 'F11');

            if (!isDel && !isF11) { return; }

            event.preventDefault();            // <F11> в браузере — полный экран

            if (!splashVisible) { return; }    // логотипа ещё нет — рано

            if (isDel) {
                registerDelPress();
                return;
            }

            teardown();                        // сразу Boot Menu
            finishPOST();
        };

        window.addEventListener('keydown', keyHandler, true);
    }

    function registerDelPress() {
        delPresses++;
        console.log('[POST] Setup request: <Del> x' + delPresses + ' / ' + DEL_PRESSES);

        if (delPresses >= DEL_PRESSES) {
            teardown();
            launchSetup();
            return;
        }

        showDelProgress(DEL_PRESSES - delPresses);
    }

    /* Прогресс под подсказкой сплэша. */
    function showDelProgress(left) {
        if (!delProgressEl) { return; }

        delProgressEl.textContent = 'Setup Request : ' + delPresses + '/' + DEL_PRESSES +
            ' \u2014 press <Del> ' + left + ' more time(s)';
    }

    /* --- 12. Выход из BIOS: teardown, Setup, переход к бутлоадеру --------- */
    function teardown() {
        runToken++;      // незаконченный POST дальше не пойдёт

        if (keyHandler) {
            window.removeEventListener('keydown', keyHandler, true);
            keyHandler = null;
        }
        if (setupTimer) {
            window.clearTimeout(setupTimer);
            setupTimer = null;
        }

        removeErrorScreen();      // экран ошибки живёт своей жизнью

        /* Артефакты перегрева привязаны к этому контейнеру: гасим их здесь,
         * а Setup включит свои, если перегрев остался в журнале. */
        if (thermalActive) {
            if (window.SurgeonOverheat && typeof window.SurgeonOverheat.stop === 'function') {
                window.SurgeonOverheat.stop();
            }
            thermalActive = false;
        }

        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
        }

        container     = null;
        logEl         = null;
        delProgressEl = null;
        delPresses    = 0;
        splashVisible = false;
        thermalNoticeEl = null;
    }

    function launchSetup() {
        if (window.SurgeonClickBios && typeof window.SurgeonClickBios.init === 'function') {
            window.SurgeonClickBios.init();
            return;
        }
        console.error('SurgeonPost: модуль Click BIOS не подключён, грузимся дальше.');
        finishPOST();
    }

    /* Boot guard: проверку делает Click BIOS — здесь только решение POST. */
    function bootGuardReason() {
        var guard = window.SurgeonBootGuard;

        if (!guard || typeof guard.check !== 'function') { return null; }
        return guard.check(null);
    }

    function denyBoot(reason) {
        var guard = window.SurgeonBootGuard;

        console.error('[BIOS] Boot guard: ' + reason);

        /* Экран "No Bootable Device" живёт в Click BIOS: BIOS молчит — грузимся. */
        if (guard && typeof guard.show === 'function') {
            guard.show(reason);
            return;
        }
        console.error('[BIOS] SurgeonBootGuard.show() не найден — экран отказа недоступен.');
    }

    function finishPOST() {
        var scan    = ensureVirtualDisk();   // финальная проверка накопителя
        var reg     = ensureRegistry();
        var reason  = bootGuardReason();
        var thermal = thermalStatus();
        var record  = thermalRecord();
        var check;

        reg.system_flags.kernel_ring = 0;
        window.SurgeonDiskReady = true;      // зелёный свет бутлоадеру

        /* 1. Обязательные пункты Setup не выставлены: таблица с адресами
         * правки и возврат в Setup. Проверка идёт первой: её таблица чинится
         * на месте, а экран boot guard — почти тупик, и показывать его
         * раньше подсказки нельзя. */
        check = setupCheck();
        if (check && check.pending.length > 0) {
            haltToSetup('CONFIGURATION REQUIRED', check.pending, false);
            return;
        }

        /* 2. Разгон за лимитами (журнал armed): артефакты, ошибка, назад в Setup. */
        if (record && record.armed === true && thermal.active === true) {
            haltToSetup('UNSTABLE OVERCLOCK  \u00b7  THERMAL OVERRIDE',
                thermalDetails(thermal), true);
            return;
        }

        /* 3. Последним — пустой VDFS первым в очереди: грузиться нечему,
         * GRUB не запускаем. Оттуда <Del> x5 всё равно ведёт в Setup. */
        if (reason) {
            denyBoot(reason);
            return;
        }

        document.dispatchEvent(new CustomEvent('bios_complete', {
            detail: {
                disk:        scan.disk.label,
                partitions:  scan.disk.partitions.length,
                created:     scan.created,
                disk_ready:  window.SurgeonDiskReady,
                kernel_ring: reg.system_flags.kernel_ring,
                speed:       perfSpeed()
            }
        }));
    }

    /* --- 13. Точка входа -------------------------------------------------- */
    function init() {
        /* Прошлый запуск обязан умереть целиком: процессы, экраны, артефакты. */
        staleProcessesKilled = resetProcessTable();
        removeErrorScreen();

        platform      = null;   // платформа читается заново: Setup мог всё поменять
        thermalActive = false;

        ensureRegistry();
        console.log('[BIOS] process table reset (' + staleProcessesKilled + ' killed), platform: SATA ' +
            ensurePlatform().sataMode + ', Legacy USB ' + (ensurePlatform().legacyUsb ? 'on' : 'off') +
            ', Secure Boot ' + (ensurePlatform().secureBoot ? 'on' : 'off') +
            ', speed x' + perfSpeed());

        /* Экран, перехват клавиш, сам прогон. */
        buildContainer();
        armSetupInterrupt();
        return runPOST();
    }

    /* Хуки для Click BIOS и будущего ядра. */
    window.TPABKA_ensureRegistry    = ensureRegistry;
    window.TPABKA_resetProcesses    = resetProcessTable;
    window.TPABKA_ensureVirtualDisk = ensureVirtualDisk;
    window.TPABKA_partitionTable    = partitionTableText;
    window.TPABKA_DISK_KEY          = DISK_KEY;

    window.SurgeonPost = {
        init:     init,
        runPOST:  runPOST,
        destroy:  teardown,
        platform: readPlatform,
        perf:     perfSnapshot,
        check:    setupCheckText,
        thermal:  thermalStatus
    };

    /* Часы машины и ускорение от разгона: их читают GRUB и ядро. */
    window.SurgeonPerf = {
        snapshot: perfSnapshot,
        speed:    perfSpeed,
        text:     function () { return perfSnapshot().text; }
    };
})(window, document);
