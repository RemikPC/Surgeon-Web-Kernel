/* ============================================================================
 * Surgeon Kernel alpha 0.1    Файл: drivers/driver_manager.js
 * ----------------------------------------------------------------------------
 * Этап 4: первый эшелон драйверов. Один менеджер держит шесть устройств —
 * ACPI, USB-шину, видео, мышь, сеть и звук — и раздаёт им три состояния:
 *     [NOT INSTALLED]          драйвера нет, железо молчит;
 *     [GENERIC / UNOPTIMIZED]  поставлено авто-паком, работает «как получилось»;
 *     [OPTIMIZED / EXCELLENT]  человек прошёл мастер и ответил по железу.
 *
 * Менеджер цепляется к ядру (core/os_core.js): дописывает свои команды
 * (status, devman, sudo, beep), просит медленный вывод, пока нет видеодрайвера,
 * вешает тормоз ядра после авто-пака и роняет машину в панику, если снести ACPI.
 *
 * Два пути установки не пересекаются: sudo install <name> — ручной мастер с
 * вопросами про железо; sudo install --auto — немой пак, клавиатуру держит
 * мьютекс ядра, драйверы встают GENERIC и тормозят машину навсегда.
 *
 * Без видеодрайвера экран сжат в 640x480 и носит класс .is-analog из kernel.css.
 *
 * Мышь — единственный драйвер, который видно глазами: с ней системный указатель
 * появляется и в меню загрузки, и в консоли ядра (system/mouse.js) — без пака в
 * NVRAM курсора нет ни там, ни там. Setup — исключение: у него мышь своя,
 * прошивочная. Ручной мастер даёт стрелке PS/2 · IRQ 12 · 3-byte packets —
 * 200 Гц, а немой --auto приносит generic · 2-byte packets с опросом 30 Гц,
 * поэтому в авто-режиме указатель идёт за рукой чуть медленнее. Каждое изменение
 * пака объявляется событием 'driver_pack_changed'.
 *
 * Команды: status · devman · sudo install <name> · sudo install --auto ·
 *          sudo del <name> · beep
 *
 * API: window.SurgeonDrivers — devices / statusOf / force / install / remove /
 *                              tree / table / beep / panic / panicBeeps / refresh
 *      window.SurgeonACPI    — флаги питания для shutdown и reboot ядра
 * ========================================================================== */
(function (window, document) {
    'use strict';

    var PA_VERSION = 'Surgeon Kernel alpha 0.1';
    var NVRAM_KEY  = 'surgeon_driver_pack';     // тот же ключ, что читает BIOS

    /* 80 ms на символ: штраф «нет видеодрайвера» тяжёлый, но мастер ещё
     * проходится без раздражения. */
    var VIDEO_LAG_MS  = 80;
    var AUTO_SLOWDOWN = 1.38;      // -38% скорости ядра после авто-пака
    var NET_FRAME_MS  = 220;       // темп полосы установки
    var REMOVE_TICK_MS = 360;      // пауза между строками снятия драйвера

    /* Порядок = порядок строк в status и ветвей в дереве devman. */
    var ORDER = ['acpi', 'network', 'video', 'usb_bus', 'mouse', 'audio'];

    var STATUS = {
        MISSING:   '[NOT INSTALLED]',
        GENERIC:   '[GENERIC / UNOPTIMIZED]',
        OPTIMIZED: '[OPTIMIZED / EXCELLENT]'
    };

    /* Цвет строки по состоянию железа: красный / жёлтый / зелёный. */
    var TONE = {};
    TONE[STATUS.MISSING]   = 'drv-err';
    TONE[STATUS.GENERIC]   = 'drv-warn';
    TONE[STATUS.OPTIMIZED] = 'drv-ok';

    /* --- 1. Каталог железа ------------------------------------------------ */
    /* quiz: вопросы мастера установки. Правильный ответ — это оптимизированная
     * настройка железа, а не проверка человека на знание: так же спрашивал
     * установщик Windows 95 и так же спрашивает любой Setup.
     * depends: без родительской шины драйвер ставить некуда. */
    var CATALOG = [
        {
            id: 'acpi',
            title: 'Power Controller Control',
            mode: 'ACPI 6.1 · S0/S5 · SCI IRQ 9',
            generic: 'legacy AT power, no FADT scan',
            depends: null,
            quiz: [{
                ask: 'Select power control mode:',
                options: ['ACPI 6.1 soft-off (S0/S5 state)', 'Legacy AT power switch'],
                correct: 1
            }]
        },
        {
            id: 'network',
            title: 'eth0 Ethernet Card',
            mode: 'NE2000 · DHCP · 10Base-T · IRQ 5',
            generic: 'NE2000 autodetect, no link negotiation',
            depends: null,
            quiz: [{
                ask: 'Select interface mode:',
                options: ['DHCP (Dynamic)', 'Static IP'],
                correct: 1
            }]
        },
        {
            id: 'video',
            title: 'VGA Video Adapter',
            mode: 'VESA VBE 3.0 · 1024x768x32 · linear framebuffer',
            generic: 'VGA text 80x25, no framebuffer',
            depends: null,
            quiz: [
                {
                    ask: 'Select display mode:',
                    options: ['VESA framebuffer (linear, 32 bpp)', 'Standard VGA text 80x25'],
                    correct: 1
                },
                {
                    /* Каретки ядро не рисует вообще: курсор остался один и живёт
                     * в BIOS. Аппаратный оверлей — это VRAM-спрайт, без него
                     * строка так и остаётся текстом без курсора. */
                    ask: 'Enable hardware cursor overlay:',
                    options: ['Yes — 8x16 sprite in VRAM', 'No — no cursor sprite, text only'],
                    correct: 1
                }
            ]
        },
        {
            id: 'usb_bus',
            title: 'Universal Serial Bus',
            mode: 'UHCI/OHCI · 2 ports · legacy HID',
            generic: 'UHCI stub, one port, no HID boot',
            depends: null,
            quiz: [{
                ask: 'Select controller mode:',
                options: ['Legacy UHCI/OHCI (USB 2.0 with HID boot)', 'xHCI only (no BIOS hand-off)'],
                correct: 1
            }]
        },
        {
            id: 'mouse',
            title: 'PS/2 Input Mouse',
            mode: 'PS/2 · IRQ 12 · 3-byte packets',
            generic: 'PS/2 IRQ 12, 2-byte packets',
            depends: 'usb_bus',
            quiz: [{
                ask: 'Select PS/2 interrupt line:',
                options: ['IRQ 11 (shared with SCSI host)', 'IRQ 12 (dedicated PS/2 aux)'],
                correct: 2
            }]
        },
        {
            id: 'audio',
            title: 'PC Speaker Beep Device',
            mode: 'PIT channel 2 · 800 Hz square wave',
            generic: 'PIT timer beeps only, no channel 2',
            depends: 'usb_bus',
            quiz: [{
                ask: 'Enable PC speaker channel:',
                options: ['Yes — 8-bit 800 Hz beep emulation', 'No — keep the machine silent'],
                correct: 1
            }]
        }
    ];

    /* Быстрый доступ к каталогу: id -> запись. */
    var BY_ID = {};
    var c;

    for (c = 0; c < CATALOG.length; c++) { BY_ID[CATALOG[c].id] = CATALOG[c]; }

    /* --- 2. Состояние менеджера -------------------------------------------- */
    var devices      = {};      // id -> { id, status, mode, auto }
    var wizardBusy   = false;   // мастер уже открыт: второй sudo без очереди не лезет
    var noticesShown = false;   // предупреждения о штрафах печатаем один раз
    var watermarkEl  = null;

    function kernel() { return window.SurgeonCore; }

    function sleep(ms) {
        return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
    }

    function isList(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function has(list, value) {
        return isList(list) && list.indexOf(value) >= 0;
    }

    function resetDevices() {
        var i, id;

        devices = {};
        for (i = 0; i < ORDER.length; i++) {
            id = ORDER[i];
            devices[id] = { id: id, status: STATUS.MISSING, mode: '-', auto: false };
        }
    }

    function isInstalled(id) {
        return !!devices[id] && devices[id].status !== STATUS.MISSING;
    }

    function isOptimized(id) {
        return !!devices[id] && devices[id].status === STATUS.OPTIMIZED;
    }

    function statusOf(id) {
        return devices[id] ? devices[id].status : STATUS.MISSING;
    }

    function tone(status) {
        return TONE[status] || 'is-dim';
    }

    /* Авто-пак оставляет след навсегда: GENERIC-драйвер тормозит всё ядро. */
    function unoptimized() {
        var i;

        for (i = 0; i < ORDER.length; i++) {
            if (devices[ORDER[i]].status === STATUS.GENERIC) { return true; }
        }
        return false;
    }

    function countStatus(status) {
        var total = 0;
        var i;

        for (i = 0; i < ORDER.length; i++) {
            if (devices[ORDER[i]].status === status) { total++; }
        }
        return total;
    }

    /* --- 3. NVRAM и реестр железа ------------------------------------------ */
    /* Драйверы живут в том же ключе NVRAM, что читает BIOS: перезагрузка
     * страницы не должна обнулять установленное железо. */
    function readPack() {
        var raw = null;
        var pack;

        try { raw = window.localStorage.getItem(NVRAM_KEY); } catch (err) { raw = null; }
        if (!raw) { return null; }

        try { pack = JSON.parse(raw); } catch (err) { return null; }
        return (pack && typeof pack === 'object') ? pack : null;
    }

    function writePack() {
        var pack = {
            version:     1,
            installed:   [],
            optimized:   [],
            auto:        [],
            modes:       {},
            unoptimized: unoptimized(),
            cooling:     false,                  // драйвер охлаждения — этап 12
            updated:     new Date().toISOString()
        };
        var i, id;

        for (i = 0; i < ORDER.length; i++) {
            id = ORDER[i];
            if (!isInstalled(id)) { continue; }

            pack.installed.push(id);
            pack.modes[id] = devices[id].mode;
            if (devices[id].auto) { pack.auto.push(id); } else { pack.optimized.push(id); }
        }

        try { window.localStorage.setItem(NVRAM_KEY, JSON.stringify(pack)); }
        catch (err) { console.warn('[DRV] NVRAM write failed: ' + err.message); }
        return pack;
    }

    /* Поднимаем состояние из NVRAM: что человек поставил, встаёт снова. */
    function loadPack() {
        var pack = readPack();
        var list;
        var i, id;

        resetDevices();
        if (!pack) { return false; }

        list = isList(pack.installed) ? pack.installed : [];
        for (i = 0; i < list.length; i++) {
            id = list[i];
            if (!devices[id]) { continue; }      // драйвер будущего этапа — не наш

            devices[id].status = has(pack.optimized, id) ? STATUS.OPTIMIZED : STATUS.GENERIC;
            devices[id].auto   = has(pack.auto, id);
            devices[id].mode   = (pack.modes && pack.modes[id]) || BY_ID[id].mode;
        }
        return true;
    }

    /* Реестр ведут POST и Setup. Мы только дописываем ветку драйвера, чтобы
     * экран Setup видел ту же картину, что и shell. */
    function syncRegistry() {
        var reg = window.TPABKA_REGISTRY;
        var i, id, dev;

        if (!reg || !reg.hardware) { return null; }
        if (!reg.system_flags) { reg.system_flags = {}; }

        for (i = 0; i < ORDER.length; i++) {
            id  = ORDER[i];
            dev = reg.hardware[id] || (reg.hardware[id] = {});

            dev.title     = BY_ID[id].title;
            dev.driver    = devices[id].status;      // строка состояния — её читает Setup
            dev.installed = isInstalled(id);
            dev.optimized = isOptimized(id);
            dev.auto      = devices[id].auto;
            dev.mode      = devices[id].mode;
            if (typeof dev.irq === 'undefined') { dev.irq = 0; }
        }

        reg.system_flags.acpi_power          = isInstalled('acpi');
        reg.system_flags.unoptimized_drivers = unoptimized();
        reg.system_flags.driver_lag_ms       = isInstalled('video') ? 0 : VIDEO_LAG_MS;
        return reg;
    }

    /* --- 4. Штрафы: тесный экран и ползущий текст -------------------------- */
    /* Видеодрайвера нет — VESA framebuffer не поднялся: терминал сжимается в
     * квадрат 640x480, вывод печатается по буквам, а на сам слой ложится
     * аналоговое размытие из core/kernel.css (класс .is-analog). Ровно за
     * снятием этого штрафа человек и идёт ставить драйвер. */
    function terminalNode() {
        return document.getElementById('surgeon-terminal');
    }

    /* Аналоговая кайма и расфокус — это CSS, а не inline: класс снимается вместе
     * с драйвером, и картинка становится цифровой в тот же кадр. */
    function setAnalog(on) {
        var node = terminalNode();

        if (!node || !node.classList) { return false; }

        if (on) { node.classList.add('is-analog'); }
        else    { node.classList.remove('is-analog'); }
        return on;
    }

    function tightViewport() {
        var node = terminalNode();

        if (!node) { return false; }

        node.style.position  = 'absolute';
        node.style.top       = '50%';
        node.style.left      = '50%';
        node.style.transform = 'translate(-50%, -50%)';
        node.style.width     = '640px';
        node.style.height    = '480px';
        node.style.border    = '2px solid #555';
        node.style.margin    = 'auto';
        node.style.filter    = '';        // фильтры живут в классе .is-analog
        setAnalog(true);                  // blur(0.7px) + contrast + кайма
        return true;
    }

    /* Драйвер встал: экран возвращается на весь монитор и становится резким. */
    function fullViewport() {
        var node = terminalNode();

        if (!node) { return false; }

        node.style.position  = 'absolute';
        node.style.top       = '0';
        node.style.left      = '0';
        node.style.transform = 'none';
        node.style.width     = '100vw';
        node.style.height    = '100vh';
        node.style.border    = 'none';
        node.style.margin    = '0';
        node.style.filter    = 'none';    // фильтры стёрты: цифровой режим
        setAnalog(false);
        return true;
    }

    /* Водяной знак в углу монитора: пока он висит, ядро идёт на 62%. */
    function toggleWatermark(on) {
        var host = document.getElementById('surgeon-monitor') || document.body;
        var node;

        if (!on) {
            if (watermarkEl && watermarkEl.parentNode) {
                watermarkEl.parentNode.removeChild(watermarkEl);
            }
            watermarkEl = null;
            return null;
        }

        if (!watermarkEl) {
            node = document.createElement('div');
            node.className = 'drv-watermark';
            node.textContent = '[ Unoptimized Drivers Mode Active ]';
            host.appendChild(node);
            watermarkEl = node;
            window.setTimeout(function () { node.classList.add('drv-on'); }, 40);
        }
        return watermarkEl;
    }

    /* --- 5. Флаги ACPI для ядра -------------------------------------------- */
    /* Ядро не разбирает драйверы: флаги питания оно спрашивает у менеджера.
     * Нет ACPI — нет мягкого S5 и нет честного сброса через FADT. */
    function syncAcpi() {
        var live  = isInstalled('acpi');
        var flags = window.SurgeonACPI || {};

        flags.installed   = live;
        flags.power_state = live ? 'S0' : 'S0 (unmanaged)';
        flags.reset       = live ? 'ACPI FADT reset register' : 'legacy 8042 reset line';
        flags.manager     = PA_VERSION;
        window.SurgeonACPI = flags;
        return flags;
    }

    /* --- 5a. Указатель мыши: то, что видно глазами ------------------------- */
    /* Право на курсор держит system/mouse.js: он один знает и слой, и режим
     * драйвера. Менеджер только спрашивает его состояние и повторяет это
     * человеку словами — «мышь встала» человек видит и без строки. */
    function mouseState() {
        var api = window.SurgeonMouse;

        if (api && typeof api.state === 'function') { return api.state(); }
        return null;
    }

    function pointerLine() {
        var mouse = mouseState();

        if (!isInstalled('mouse')) {
            return { text: '[ WARN ] mouse: no driver — no pointer in the boot menu ' +
                'or the kernel console.', cls: 'is-warn' };
        }
        if (!mouse || !mouse.installed) {
            return { text: '[ WARN ] mouse: driver is up, but the console layer is ' +
                'missing (system/mouse.js).', cls: 'is-warn' };
        }

        return {
            text: (mouse.generic ? '[ WARN ] ' : '[ OK ] ') + mouse.report,
            cls:  mouse.generic ? 'drv-warn' : 'is-ok'
        };
    }

    /* Пересчёт штрафов. deferWatermark — загрузка: терминал ещё скрыт, знак
     * повесим позже, когда shell поднимется и экран уже станет видно. */
    function applyPenalties(deferWatermark) {
        var k    = kernel();
        var slow = !isInstalled('video');

        if (k && typeof k.setCharDelay === 'function') {
            k.setCharDelay(slow ? VIDEO_LAG_MS : 0);
            k.setSpeedPenalty(unoptimized() ? AUTO_SLOWDOWN : 1);
        }

        if (slow) { tightViewport(); } else { fullViewport(); }

        if (deferWatermark !== true) { toggleWatermark(unoptimized()); }
        syncAcpi();
        syncRegistry();
        return devices;
    }

    /* Пак сменился — об этом стоит сказать наружу: указатель мыши
     * (system/mouse.js) держится на том же ключе NVRAM и перечитывает его
     * ровно тогда, когда пак изменился. */
    function announcePack() {
        document.dispatchEvent(new window.CustomEvent('driver_pack_changed', {
            detail: readPack()
        }));
        return true;
    }

    /* Любая установка или снятие драйвера заканчивается этим пересчётом. */
    function commit() {
        writePack();
        announcePack();
        return applyPenalties(false);
    }

    /* --- 6. Текстовые помощники -------------------------------------------- */
    function repeat(text, count) {
        var out = '';
        var i;

        for (i = 0; i < count; i++) { out += text; }
        return out;
    }

    function pad(text, width) {
        var out = String(text);

        while (out.length < width) { out += ' '; }
        return out.slice(0, width);
    }

    function padDots(text, width) {
        var out = String(text);

        while (out.length < width) { out += '-'; }
        return out.slice(0, width);
    }

    function center(text, width) {
        var out  = String(text);
        var left = Math.floor((width - out.length) / 2);

        if (left < 0) { left = 0; }
        out = repeat(' ', left) + out;

        while (out.length < width) { out += ' '; }
        return out.slice(0, width);
    }

    /* Linux-полоса: [===========>     ] 70% */
    function progressText(percent, size) {
        var width  = size || 16;
        var filled = Math.round(width * percent / 100);
        var out    = '';
        var i;

        if (filled < 1) { filled = 1; }
        if (filled > width) { filled = width; }

        for (i = 0; i < width; i++) {
            out += (i < filled - 1) ? '=' : ((i === filled - 1) ? '>' : ' ');
        }
        return '[' + out + '] ' + (percent < 100 ? ' ' + percent : percent) + '%';
    }

    /* Полоса растёт в одной строке — печатать её по буквам нельзя. Кадры идут
     * редко: установка специально занимает время, как на живом железе. */
    async function animateDownload(label, frames, totalMs, size) {
        var node = kernel().printLine('[ .. ] ' + label + ' ' + progressText(0, size), 'is-dim');
        var step = Math.round(totalMs / (frames - 1));
        var i;

        for (i = 1; i < frames; i++) {
            await sleep(step);
            node.textContent = '[ .. ] ' + label + ' ' +
                progressText(Math.round(100 * i / (frames - 1)), size);
        }

        node.textContent = '[ OK ] ' + label + ' ' + progressText(100, size);
        node.className = 'kernel-line is-ok';
        return node;
    }

    /* Имя модуля: у сетевой карты оно своё, у остальных совпадает с устройством. */
    function moduleName(id) {
        return (id === 'network' ? 'ne2000' : id) + '.ko';
    }

    /* Установка — ритуал из трёх полос. Каждая ждёт своей очереди, поэтому
     * драйвер не «появляется» мгновенно. */
    async function runInstallStages(id) {
        var k    = kernel();
        var unit = moduleName(id);

        await animateDownload('Fetch ' + unit + ' from repo:', 20, 3400);
        await k.emit('[ .. ] module signature valid, dependencies resolved.', 'is-dim');
        await animateDownload('Verify ' + unit + ':', 12, 1600);
        await animateDownload('Link + register ' + unit + ':', 16, 2600);
        await k.emit('[ .. ] controller probe started, IRQ lines claimed.', 'is-dim');
        return true;
    }

    /* Строки печатаются по одной: при штрафе видеодрайвера они идут ползком. */
    async function emitLines(lines) {
        var i;

        for (i = 0; i < lines.length; i++) {
            await kernel().emit(lines[i].text, lines[i].cls);
        }
        return true;
    }

    /* --- 7. status: таблица из шести устройств ----------------------------- */
    var COL = { id: 8, hardware: 24, status: 23 };

    function ruleLine() {
        return '  +' + repeat('-', COL.id + 2) +
            '+' + repeat('-', COL.hardware + 2) +
            '+' + repeat('-', COL.status + 2) + '+';
    }

    function rowLine(id, hardware, status) {
        return '  | ' + pad(id, COL.id) + ' | ' + pad(hardware, COL.hardware) +
            ' | ' + pad(status, COL.status) + ' |';
    }

    function tableLines() {
        var out = [];
        var i, id;

        out.push({ text: PA_VERSION + ' — DEVICE DRIVER STATUS', cls: 'is-info' });
        out.push({ text: ruleLine(), cls: 'is-dim' });
        out.push({ text: rowLine('DEVICE', 'HARDWARE', 'STATUS'), cls: 'is-dim' });
        out.push({ text: ruleLine(), cls: 'is-dim' });

        for (i = 0; i < ORDER.length; i++) {
            id = ORDER[i];
            out.push({ text: rowLine(id, BY_ID[id].title, devices[id].status),
                cls: tone(devices[id].status) });
        }

        out.push({ text: ruleLine(), cls: 'is-dim' });
        return out;
    }

    /* Состояние склада: без драйвера сети брать драйверы негде. */
    function repoLine() {
        if (isInstalled('network')) {
            return { text: '[ OK ] Repository online over eth0 — sudo install <name> works.',
                cls: 'is-ok' };
        }
        return { text: '[ ERR ] Repository unreachable — network driver is not installed.',
            cls: 'is-err' };
    }

    /* Штрафы, о которых человек должен узнать сразу после status. */
    function penaltyLines(lines) {
        if (!isInstalled('video')) {
            lines.push({ text: '[ WARN ] video: no VGA driver — output crawls at ' +
                VIDEO_LAG_MS + ' ms/char, viewport pinned to 640x480.', cls: 'is-warn' });
            lines.push({ text: '[ INFO ] fix it with: sudo install video', cls: 'is-dim' });
        }
        if (unoptimized()) {
            lines.push({ text: '[ WARN ] generic pack active — kernel speed penalty ' +
                Math.round((AUTO_SLOWDOWN - 1) * 100) +
                '% ([ Unoptimized Drivers Mode Active ]).', cls: 'is-warn' });
        }
        return lines;
    }

    async function cmdStatus() {
        var lines = tableLines();

        lines.push({ text: '  ' + countStatus(STATUS.OPTIMIZED) + ' optimized · ' +
            countStatus(STATUS.GENERIC) + ' generic · ' + countStatus(STATUS.MISSING) +
            ' missing of ' + ORDER.length + ' devices', cls: 'is-dim' });
        lines.push(repoLine());
        penaltyLines(lines);
        return emitLines(lines);
    }

    /* --- 8. devman: физическое дерево устройств ---------------------------- */
    /* Подпись ребёнка шины короче ровно на отступ (пять пробелов): так все
     * стрелки встают в одну колонку. */
    var TREE_LABEL_ROOT  = 33;
    var TREE_LABEL_CHILD = 28;

    function deviceLabel(id) {
        return '[' + id.toUpperCase() + '] ' + BY_ID[id].title;
    }

    function treeBranch(id, last, indent, labelWidth) {
        var glyph = indent + (last ? '└─── ' : '├─── ');

        return glyph + padDots(deviceLabel(id), labelWidth) + '> ' + statusOf(id);
    }

    function treeLines() {
        return [
            { text: '┌─ Motherboard (' + PA_VERSION + ')', cls: 'is-dim' },
            { text: treeBranch('acpi', false, '', TREE_LABEL_ROOT),
                cls: tone(statusOf('acpi')) },
            { text: treeBranch('network', false, '', TREE_LABEL_ROOT),
                cls: tone(statusOf('network')) },
            { text: treeBranch('video', false, '', TREE_LABEL_ROOT),
                cls: tone(statusOf('video')) },
            { text: treeBranch('usb_bus', true, '', TREE_LABEL_ROOT),
                cls: tone(statusOf('usb_bus')) },
            { text: treeBranch('mouse', false, '     ', TREE_LABEL_CHILD),
                cls: tone(statusOf('mouse')) },
            { text: treeBranch('audio', true, '     ', TREE_LABEL_CHILD),
                cls: tone(statusOf('audio')) }
        ];
    }

    /* Список устройств без драйвера — чтобы не искать их глазами по дереву. */
    function missingList() {
        var out = [];
        var i;

        for (i = 0; i < ORDER.length; i++) {
            if (!isInstalled(ORDER[i])) { out.push(ORDER[i]); }
        }
        return out;
    }

    async function cmdDevman() {
        var lines = treeLines();
        var missing = missingList();

        if (missing.length) {
            lines.push({ text: '', cls: '' });
            lines.push({ text: '[ INFO ] no driver: ' + missing.join(' · ') +
                ' — sudo install <name>', cls: 'is-dim' });
        }
        return emitLines(lines);
    }

    /* --- 9. Диалог мастера: вопрос — ответ --------------------------------- */
    /* Набранная строка уходит не диспетчеру команд, а сюда: ядро на время
     * вопроса держит хук holdInput, поэтому мастер получает ровно свой ответ. */
    function parseChoice(answer, max) {
        var num = parseInt(String(answer).replace(/[^0-9]/g, ''), 10);

        if (!isFinite(num) || num < 1 || num > max) { return 0; }
        return num;
    }

    function askOnce(question) {
        return new Promise(function (resolve) {
            kernel().holdInput(function (answer) {
                resolve(parseChoice(answer, question.options.length));
            });
        });
    }

    function optionText(question) {
        var text = '';
        var i;

        for (i = 0; i < question.options.length; i++) {
            text += (i ? ' ' : '') + (i + 1) + ') ' + question.options[i];
        }
        return text;
    }

    /* Вопрос печатается, приглашение встаёт на экран, хук уже стоит: промахнуться
     * мимо мастера можно только одной клавишей, и это ловится ниже. */
    async function ask(question) {
        var k      = kernel();
        var choice;

        await k.emit('[ ? ] ' + question.ask + ' ' + optionText(question), 'is-info');
        k.showPrompt();

        choice = await askOnce(question);
        if (choice === 0) {
            await k.emit('[ WARN ] input not understood — answer 1..' +
                question.options.length + '.', 'is-warn');
            k.showPrompt();
            choice = await askOnce(question);
        }
        return choice;
    }

    /* Мастер идёт по вопросам по очереди. Все ответы верны — драйвер встал
     * оптимизированным; промах — работает, но со флагом GENERIC.
     * Это ручной путь: человек сам выбирает режим железа, и до первого вопроса
     * ввод у него никто не отбирает (ядро открывает мьютекс на holdInput). */
    async function runQuiz(id) {
        var k     = kernel();
        var quiz  = BY_ID[id].quiz;
        var right = 0;
        var i, choice, ok, question;

        await k.emit('[ INFO ] manual setup: ' + quiz.length + ' question(s) for ' + id +
            ' — answer by number, the exact hardware answers earn ' +
            '[OPTIMIZED / EXCELLENT].', 'is-info');

        for (i = 0; i < quiz.length; i++) {
            question = quiz[i];
            choice   = await ask(question);
            ok       = (choice === question.correct);

            if (ok) { right++; }
            await k.emit(ok
                ? '[ OK ] ' + question.options[choice - 1] + ' — applied.'
                : '[ WARN ] controller probe rejected the setting — falling back to defaults.',
                ok ? 'is-ok' : 'is-warn');
        }
        return right === quiz.length;
    }

    /* --- 10. Установка драйвера -------------------------------------------- */
    function genericMode(id) {
        return 'generic · ' + BY_ID[id].generic;
    }

    /* Склад отвечает только по сети: нет сетевого драйвера — нет пакетов. */
    function repoReachable() {
        return isInstalled('network');
    }

    /* Текст ошибки склада — ровно тот, который ждёт человек и тесты. */
    function repoError() {
        return '[ERR] Repository unreachable. Load network driver first!';
    }

    async function reportInstall(id) {
        var k   = kernel();
        var dev = devices[id];
        var arrow;

        await k.emit('[ OK ] ' + id + ': ' + BY_ID[id].title + ' bound — ' + dev.mode, 'is-ok');
        await k.emit('       state: ' + dev.status, tone(dev.status));

        /* Мышь — единственный драйвер, который видно глазами: с ней на экране
         * появляется указатель, и об этом человеку говорят прямо. */
        if (id === 'mouse') {
            arrow = pointerLine();
            await k.emit(arrow.text, arrow.cls);
        }

        /* Штраф снят — говорим об этом прямо, иначе этого просто не заметят. */
        if (id === 'video') {
            await k.emit('[ OK ] video: lag purged — full-screen viewport restored, ' +
                'no character delay.', 'is-ok');
        }
        if (id === 'acpi') {
            await k.emit('[ OK ] acpi: S5 soft-off and FADT reset are available again.',
                'is-ok');
        }
        return dev;
    }

    async function finishInstall(id, optimized) {
        devices[id].status = optimized ? STATUS.OPTIMIZED : STATUS.GENERIC;
        devices[id].auto   = false;
        devices[id].mode   = optimized ? BY_ID[id].mode : genericMode(id);

        commit();
        return reportInstall(id);
    }

    /* Сеть — сам склад: её модуль приходит с образа, а не с сервера. */
    async function setupNetwork() {
        var k = kernel();

        await animateDownload('Fetch ne2000.ko from image:', 20, NET_FRAME_MS * 14);
        await animateDownload('Verify ne2000.ko:', 12, NET_FRAME_MS * 6);
        await k.emit('[ OK ] ne2000.ko unpacked (12 KB), module signature valid.', 'is-ok');
        return runQuiz('network');
    }

    /* Мастер ставит один драйвер за раз: человек видит, за что именно заплатил. */
    async function installDriver(id) {
        var k = kernel();

        if (!BY_ID[id]) {
            await k.emit('[ ERR ] sudo: unknown device "' + id + '".', 'is-err');
            await k.emit('        known devices: ' + ORDER.join(', '), 'is-dim');
            return false;
        }
        if (isInstalled(id)) {
            await k.emit('[ WARN ] ' + id + ': driver already installed — ' +
                devices[id].status, 'is-warn');
            await k.emit('        rebuild it: sudo del ' + id + ' && sudo install ' + id,
                'is-dim');
            return false;
        }
        if (id !== 'network' && !repoReachable()) {
            await k.emit(repoError(), 'is-err');
            return false;
        }

        /* Мышь и звук живут на шине: без неё ставить их некуда. */
        if (BY_ID[id].depends && !isInstalled(BY_ID[id].depends)) {
            await k.emit('[ERR] Dependency Check Failed: ' + BY_ID[id].depends +
                ' driver required!', 'is-err');
            return false;
        }

        if (id === 'network') { return finishInstall(id, await setupNetwork()); }

        /* Полосы идут до вопросов мастера: сначала модуль, потом железо. */
        await runInstallStages(id);
        return finishInstall(id, await runQuiz(id));
    }

    async function sudoUsage() {
        var k = kernel();

        await k.emit('sudo: usage — sudo install <driver> | sudo install --auto | ' +
            'sudo del <driver>', 'is-dim');
        await k.emit('      drivers: ' + ORDER.join(' · '), 'is-dim');
        await k.emit('      install <driver> runs the manual wizard — answer the ' +
            'questions for [OPTIMIZED / EXCELLENT].', 'is-dim');
        await k.emit('      install --auto skips the wizard: blind GENERIC modules, ' +
            'no questions asked.', 'is-dim');
        await k.emit('      the repository answers over eth0 only.', 'is-dim');
        return false;
    }

    /* Один мастер за раз: два диалога на одной строке ввода — это каша.
     * Хук снимаем и на выходе: мастер не должен оставлять после себя «немой»
     * ввод, если его прервали. */
    async function withWizard(job) {
        var k = kernel();
        var result;

        wizardBusy = true;
        try {
            result = await job();
        } finally {
            wizardBusy = false;
            if (k && typeof k.releaseInput === 'function') { k.releaseInput(); }
        }
        return result;
    }

    async function cmdSudo(args) {
        var parts  = String(args || '').trim().split(/\s+/);
        var action = (parts[0] || '').toLowerCase();
        var name   = (parts[1] || '').toLowerCase();

        if (wizardBusy) {
            await kernel().emit('[ WARN ] sudo: an install wizard is already running — ' +
                'answer it first.', 'is-warn');
            return false;
        }

        if (action === 'install') {
            /* --auto — тоже работа мастера, только немого: пока он ставит пак,
             * второй sudo не влезет, а клавиатуру держит ядро. */
            if (name === '--auto') { return withWizard(autoInstall); }
            if (!name) { return sudoUsage(); }
            return withWizard(function () { return installDriver(name); });
        }
        if (action === 'del' || action === 'remove') {
            if (!name) { return sudoUsage(); }
            return withWizard(function () { return removeDriver(name); });
        }
        return sudoUsage();
    }

    /* --- 11. sudo install --auto: универсальный пак ------------------------ */
    /* Пак ставит всё сразу и вслепую: драйверы получают флаг GENERIC и навсегда
     * тормозят ядро. Это и есть цена скорости установки.
     * Мастер здесь не задаёт НИ ОДНОГО вопроса и не даёт ни одного выбора: пока
     * пак работает, мьютекс ввода ядра (см. core/os_core.js, 7d) держит
     * клавиатуру закрытой, поэтому нажатия человека никуда не уходят. */
    async function autoInstall() {
        var k       = kernel();
        var pending = [];
        var arrow;
        var i, id;

        /* Без сети пак не скачать: сначала сетевой драйвер, потом всё остальное. */
        if (!repoReachable()) {
            await k.emit(repoError(), 'is-err');
            return false;
        }

        for (i = 0; i < ORDER.length; i++) {
            id = ORDER[i];
            if (!isInstalled(id)) { pending.push(id); }
        }

        if (!pending.length) {
            await k.emit('[ INFO ] driver pack: every device already has a driver.',
                'is-dim');
            return false;
        }

        await k.emit('[ INFO ] --auto: interactive wizard skipped — no questions, ' +
            'no choices; modules are forced blind onto the hardware.', 'is-dim');
        await animateDownload('Fetch driver pack (' + pending.length + ' modules):',
            26, 4400);
        await animateDownload('Verify + unpack the pack:', 14, 2000);
        await k.emit('[ OK ] pack received: ' + pending.length +
            ' modules, signature checked.', 'is-ok');

        for (i = 0; i < pending.length; i++) {
            id = pending[i];
            devices[id].status = STATUS.GENERIC;
            devices[id].auto   = true;
            devices[id].mode   = genericMode(id);
            await k.emit('[ OK ] ' + id + ': installed (GENERIC / UNOPTIMIZED) — ' +
                devices[id].mode, 'drv-warn');
        }

        commit();
        await k.emit('[ WARN ] generic pack in place — kernel speed penalty ' +
            Math.round((AUTO_SLOWDOWN - 1) * 100) + '% on every command.', 'is-warn');
        await k.emit('[ WARN ] [ Unoptimized Drivers Mode Active ] — the watermark stays ' +
            'until the devices are set up by hand.', 'is-warn');
        await k.emit('[ INFO ] sudo del <name> then sudo install <name> lifts the penalty ' +
            'for that device.', 'is-dim');

        /* Мышь в этом паке идёт generic-драйвером: указатель тоже появляется, но
         * за рукой идёт мягче — 2 байта на пакет и опрос 30 Гц вместо 200. */
        arrow = pointerLine();
        await k.emit(arrow.text, arrow.cls);
        return true;
    }

    /* --- 12. sudo del: снятие драйвера ------------------------------------- */
    function markMissing(id) {
        devices[id].status = STATUS.MISSING;
        devices[id].auto   = false;
        devices[id].mode   = '-';
        return devices[id];
    }

    async function confirmRemoval(id) {
        var k      = kernel();
        var answer;

        await k.emit('Remove driver "' + id + '" (' + BY_ID[id].title + ')? (y/n)', 'is-warn');
        k.showPrompt();

        answer = await new Promise(function (resolve) {
            k.holdInput(function (text) { resolve(String(text || '').trim().toLowerCase()); });
        });
        return (answer === 'y' || answer === 'yes');
    }

    /* Снятие шины тянет за собой детей: полудрайвер хуже, чем его отсутствие. */
    async function dropDependents(parent) {
        var k = kernel();
        var i, id;

        for (i = 0; i < ORDER.length; i++) {
            id = ORDER[i];
            if (BY_ID[id].depends !== parent || !isInstalled(id)) { continue; }

            markMissing(id);
            await k.emit('[ WARN ] ' + id + ': parent bus removed — driver dropped.',
                'is-warn');
        }
    }

    /* Драйвер отпускает железо по шагам: строки идут друг за другом, и только
     * после последней модуль действительно уходит из дерева. */
    async function runRemovalSteps(id) {
        var k    = kernel();
        var unit = moduleName(id);
        var i;

        var steps = [
            unit + ': refcount 0, flushing pending requests',
            unit + ': IRQ released, DMA buffers back on the bus',
            '/dev/' + id + ' detached, driver table entry cleared'
        ];

        for (i = 0; i < steps.length; i++) {
            await k.emit('[ .. ] ' + steps[i], 'is-dim');
            await sleep(REMOVE_TICK_MS);
        }

        return k.emit('[ OK ] ' + id + ': driver unloaded, IRQ released.', 'is-ok');
    }

    async function removeDriver(id) {
        var k        = kernel();
        var hadMouse = false;

        if (!BY_ID[id]) {
            await k.emit('[ ERR ] sudo: unknown device "' + id + '".', 'is-err');
            return false;
        }
        if (!isInstalled(id)) {
            await k.emit('[ WARN ] ' + id + ': nothing to remove — ' + STATUS.MISSING + '.',
                'is-warn');
            return false;
        }

        /* ACPI — критическая подсистема: предупреждаем до подтверждения. */
        if (id === 'acpi') {
            await k.emit('[ ERR ] WARNING: the ACPI power controller is a critical ' +
                'kernel subsystem.', 'is-err');
            await k.emit('[ ERR ] Removing it halts the kernel immediately. This is on you.',
                'is-err');
        }

        if (!await confirmRemoval(id)) {
            await k.emit('[ INFO ] ' + id + ': removal cancelled.', 'is-dim');
            return false;
        }

        /* Кнопку «y» на ACPI ядро не переживает: уходим в панику. */
        if (id === 'acpi') { return acpiSabotage(); }

        hadMouse = isInstalled('mouse');

        await runRemovalSteps(id);
        markMissing(id);
        await dropDependents(id);
        commit();

        /* Мышь ушла — сама или вместе с шиной: указателя нет ни в меню, ни здесь. */
        if (hadMouse && !isInstalled('mouse')) {
            await k.emit('[ WARN ] mouse: pointer offline — the boot menu and the ' +
                'kernel console are keyboard-only again.', 'is-warn');
        }
        return true;
    }

    /* --- 13. Саботаж ACPI: паника ядра ------------------------------------- */
    /* Человек сам снял драйвер питания и подтвердил это. Ядро не может отдать
     * SCI обратно и валится на первом прерывании — показываем честный дамп. */
    var PANIC_HZ    = 400;      // низкий гудок: код смерти, а не «щелчок»
    var PANIC_MS    = 700;
    var PANIC_BEEPS = 2;
    var panicBeepCount = 0;

    var PANIC_FRAMES = [
        'acpi_remove_driver+0x42/0x90',
        'device_release_driver+0x1A/0x30',
        'kernfs_fop_write_iter+0x11E/0x1C0',
        'vfs_write+0x1D7/0x3E0',
        'ksys_write+0x6D/0xB0',
        'do_syscall_64+0x3B/0x90',
        'entry_SYSCALL_64_after_hwframe+0x44/0xAE',
        'schedule+0x44C/0x9B0',
        'ret_from_fork+0x35/0x40'
    ];

    function panicAddress(index) {
        var base = 0x81A3C1D2 + index * 0x2C0;

        return '[<FFFF' + base.toString(16).toUpperCase() + '>] ';
    }

    function clockText(date) {
        var two = function (value) { return (value < 10 ? '0' : '') + value; };

        return two(date.getHours()) + ':' + two(date.getMinutes()) + ':' +
            two(date.getSeconds());
    }

    /* Тонкая линейка раздела: ┌─ ИМЯ ──────────────────────────── */
    function rule(text) {
        var tail = 46 - String(text).length;

        return '┌─ ' + text + ' ' + repeat('─', tail < 4 ? 4 : tail);
    }

    /* Дамп регистров: всё, что успел снять обработчик до выключения IRQ. */
    function panicDump() {
        var out = [];
        var i;

        out.push({ text: '[ FATAL ] Driver hot-unplug: acpi — Power Controller Control',
            cls: 'drv-panic-head' });
        out.push({ text: '[ FATAL ] 65535 unhandled SCI interrupts in 12 ms — SMM storm.',
            cls: 'drv-panic-head' });
        out.push({ text: '[ FATAL ] IRQ 9 has no owner any more — the kernel cannot give it back.',
            cls: 'drv-panic' });
        out.push({ text: '[ BIOS  ] POST speaker: ' + PANIC_BEEPS + ' low tones @ ' + PANIC_HZ +
            ' Hz (beep code 0F — fatal).', cls: 'drv-panic-head' });
        out.push({ text: '', cls: '' });
        out.push({ text: rule('CPU#0 REGISTERS'), cls: 'drv-panic-head' });
        out.push({ text: '  CR0 = 0x80000011 (PE|PG|CD|NW)   CR3 = 0x1A4C9000   ' +
            'CR2 = 0x00000000', cls: 'drv-panic' });
        out.push({ text: '  CR4 = 0x000406F0 (SMEP|SMAP|OSXSAVE)   ' +
            'EFLAGS = 0x00010246 (IF=0, IRQ9 masked)', cls: 'drv-panic' });
        out.push({ text: '  RIP = 0xFFFFFFFF81A3C1D2  acpi_remove_driver+0x42/0x90  <-- fault',
            cls: 'drv-panic' });
        out.push({ text: '  RSP = 0xFFFF88807B3C7D40   RBP = 0xFFFF88807B3C7D80   CS = 0x0010',
            cls: 'drv-panic' });
        out.push({ text: '  RAX = 0x0000000000000001   RBX = 0xFFFF88807A011200   ' +
            'RCX = 0x000000000000000B', cls: 'drv-panic' });
        out.push({ text: '  IDTR = 0xFFFFFE0000000000   GDTR = 0xFFFFFE0000001000   ' +
            'Ring 0 trap', cls: 'drv-panic' });
        out.push({ text: '  no handler owns IRQ 9 any more', cls: 'drv-panic' });
        out.push({ text: '', cls: '' });
        out.push({ text: rule('STACK TRACE — IRQ 9 ACPI SCI on CPU#0'),
            cls: 'drv-panic-head' });
        out.push({ text: '  IRQ 9  ACPI SCI ........ unhandled (GPE block offline)',
            cls: 'drv-panic' });

        for (i = 0; i < PANIC_FRAMES.length; i++) {
            out.push({ text: '  ' + panicAddress(i) + PANIC_FRAMES[i] + '  <TASK>',
                cls: 'drv-panic' });
        }

        out.push({ text: '', cls: '' });
        out.push({ text: rule('AFTERMATH'), cls: 'drv-panic-head' });
        out.push({ text: '  Kernel Offset: 0x1C000000 from 0xFFFFFFFF81000000',
            cls: 'drv-panic' });
        out.push({ text: '  Uptime: ' + pad(clockText(new Date()), 12) +
            'Build: ' + PA_VERSION, cls: 'drv-panic' });
        out.push({ text: '  Power state: S5 unreachable — the ACPI controller is gone.',
            cls: 'drv-panic' });
        out.push({ text: '  Reset line: none. This machine cannot restart itself.',
            cls: 'drv-panic' });
        out.push({ text: '', cls: '' });
        return out;
    }

    /* Пищалка висит на плате, а не на аудиодрайвере: паника пищит всегда, даже
     * когда звук в системе не поднят. Два длинных низких гудка — как у железа. */
    function panicBeep() {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        var ctx, osc, gain, start, i, resume;

        if (!Ctor) { return false; }

        try {
            ctx = new Ctor();
            if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                resume = ctx.resume();
                if (resume && typeof resume.catch === 'function') { resume.catch(function () {}); }
            }

            for (i = 0; i < PANIC_BEEPS; i++) {
                start = ctx.currentTime + i * 0.9;
                osc   = ctx.createOscillator();
                gain  = ctx.createGain();

                osc.type            = 'square';
                osc.frequency.value = PANIC_HZ;

                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.linearRampToValueAtTime(0.17, start + 0.02);
                gain.gain.linearRampToValueAtTime(0.0001, start + PANIC_MS / 1000);

                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(start);
                osc.stop(start + PANIC_MS / 1000);
            }

            /* Контекст живёт до конца последнего гудка, потом закрывается. */
            window.setTimeout(function () {
                if (typeof ctx.close === 'function') { ctx.close(); }
            }, (PANIC_BEEPS * 900) + PANIC_MS + 400);
        } catch (err) {
            console.warn('[DRV] panic beep failed: ' + err.message);
            return false;
        }

        panicBeepCount += 1;
        return true;
    }

    /* Рама вокруг дампа и правда о последствиях: с ACPI нет ни FADT reset, ни
     * S5 — перезапускать машину ядру больше нечем. Плашка узкая и стоит
     * посередине экрана: это не строка консоли, а надгробие машины. */
    var PANIC_BOX_WIDTH = 56;

    /* Колонок в консоли куда больше, чем символов в раме: без отступа плашка
     * липнет к левому краю. Ширину знакоместа меряет canvas по шрифту слоя. */
    function consoleColumns() {
        var node  = terminalNode();
        var style, canvas, measure, cell, inner;

        if (!node || typeof window.getComputedStyle !== 'function') { return 0; }

        try {
            style   = window.getComputedStyle(node);
            canvas  = document.createElement('canvas');
            measure = (canvas && typeof canvas.getContext === 'function')
                ? canvas.getContext('2d') : null;
            if (!measure) { return 0; }

            measure.font = style.fontSize + ' ' + style.fontFamily;
            cell  = measure.measureText('MMMMMMMMMM').width / 10;
            inner = node.clientWidth - parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight);
            if (!cell || !isFinite(cell) || !inner || inner <= 0) { return 0; }

            return Math.floor(inner / cell);
        } catch (err) {
            return 0;      // canvas молчит — плашка встанет без отступа
        }
    }

    /* Отступ, который ставит плашку посередине экрана. */
    function frameIndent(width) {
        var cols = consoleColumns();

        if (!cols || cols <= width + 2) { return 0; }
        return Math.floor((cols - (width + 2)) / 2);
    }

    function panicFrame() {
        var width  = PANIC_BOX_WIDTH;
        var indent = repeat(' ', frameIndent(width));
        var out    = [];
        var body   = [
            'ACPI was unplugged while the kernel was alive.',
            'IRQ 9 never came back: SCI storm, GPE offline.',
            'The reset line went with the driver — no S5.'
        ];
        var i;

        out.push({ text: indent + '╔' + repeat('═', width) + '╗', cls: 'drv-panic-frame' });
        out.push({ text: indent + '║' + center('!!! SYSTEM HALTED — KERNEL PANIC !!!', width) + '║',
            cls: 'drv-panic-banner' });
        out.push({ text: indent + '║' +
            center('ACPI_SUBSYSTEM_CRITICAL_FAILURE — CPU#0, ring 0', width) + '║',
            cls: 'drv-panic-frame' });
        out.push({ text: indent + '╠' + repeat('═', width) + '╣', cls: 'drv-panic-frame' });

        for (i = 0; i < body.length; i++) {
            out.push({ text: indent + '║  ' + pad(body[i], width - 2) + '║', cls: 'drv-panic' });
        }

        out.push({ text: indent + '╠' + repeat('═', width) + '╣', cls: 'drv-panic-frame' });
        out.push({ text: indent + '║' +
            center('POWER DOWN — this machine cannot restart itself', width) + '║',
            cls: 'drv-panic-banner' });
        out.push({ text: indent + '╚' + repeat('═', width) + '╝', cls: 'drv-panic-frame' });
        out.push({ text: '', cls: '' });
        out.push({ text: '[ HALTED ] Input is dead: no S5, no reset line, no F5 — power only.',
            cls: 'drv-err' });
        return out;
    }

    /* Экран чистится, дамп печатается мгновенно: паника не ждёт штрафов. */
    async function acpiSabotage() {
        var k    = kernel();
        var dump;
        var i;

        k.clear();
        panicBeep();                 // пищим сразу: экран уже мёртв

        markMissing('acpi');
        writePack();
        syncAcpi();
        syncRegistry();

        dump = panicDump().concat(panicFrame());
        for (i = 0; i < dump.length; i++) {
            k.printLine(dump[i].text, dump[i].cls);
        }

        return k.halt();
    }

    /* --- 14. beep: пищалка PC speaker, 800 Гц, 200 мс ----------------------- */
    var BEEP_HZ = 800;
    var BEEP_MS = 200;

    /* Волну оцифровываем в 8 бит: живая пищалка, а не «synth lead». */
    function bitCurve(bits) {
        var levels = 1 << bits;
        var curve  = new Float32Array(1024);
        var x;
        var i;

        for (i = 0; i < curve.length; i++) {
            x = ((i / (curve.length - 1)) * 2 - 1);
            curve[i] = Math.round(x * levels) / levels;
        }
        return curve;
    }

    function playBeep(Ctor) {
        var ctx    = new Ctor();
        var osc    = ctx.createOscillator();
        var shaper = ctx.createWaveShaper();
        var gain   = ctx.createGain();
        var stop   = ctx.currentTime + (BEEP_MS / 1000);

        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') { ctx.resume(); }

        osc.type            = 'square';
        osc.frequency.value = BEEP_HZ;
        shaper.curve        = bitCurve(8);

        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 0.01);
        gain.gain.linearRampToValueAtTime(0.0001, stop);

        osc.connect(shaper);
        shaper.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(stop);
        osc.onended = function () {
            if (typeof ctx.close === 'function') { ctx.close(); }
        };
        return true;
    }

    /* Драйвер звука — это то же железо, что и пищалка: без него молчание. */
    async function cmdBeep() {
        var k    = kernel();
        var Ctor = window.AudioContext || window.webkitAudioContext;

        if (!isInstalled('audio')) {
            await k.emit('[ERR] Audio hardware not initialized', 'is-err');
            await k.emit('       hint: sudo install audio (PIT channel 2).', 'is-dim');
            return false;
        }
        if (!Ctor) {
            await k.emit('[ WARN ] AudioContext is not available in this browser.', 'is-warn');
            return false;
        }

        playBeep(Ctor);
        await k.emit('[ OK ] PC speaker: ' + BEEP_HZ + ' Hz, 8-bit square, ' + BEEP_MS +
            ' ms.', 'is-ok');
        return true;
    }

    /* --- 15. Сервисный API ------------------------------------------------- */
    /* Снимок состояния: им пользуются Setup, тесты и следующие этапы. */
    function snapshot() {
        var out = {};
        var i, id;

        for (i = 0; i < ORDER.length; i++) {
            id = ORDER[i];
            out[id] = {
                id:      id,
                title:   BY_ID[id].title,
                status:  devices[id].status,
                mode:    devices[id].mode,
                auto:    devices[id].auto,
                depends: BY_ID[id].depends
            };
        }
        return out;
    }

    /* Сервисный путь: поставить драйвер без мастера (тесты и следующие этапы). */
    function forceInstall(id, optimized, auto) {
        if (!BY_ID[id]) { return false; }

        devices[id].status = optimized ? STATUS.OPTIMIZED : STATUS.GENERIC;
        devices[id].auto   = (auto === true);
        devices[id].mode   = optimized ? BY_ID[id].mode : genericMode(id);
        commit();
        return true;
    }

    /* Перечитать NVRAM и пересчитать штрафы: после Setup или смены плана. */
    function refresh() {
        loadPack();
        announcePack();
        return applyPenalties(false);
    }

    /* --- 16. Стили менеджера ----------------------------------------------- */
    /* Паника живёт здесь, а не в kernel.css: это цвета драйверного слоя. */
    var STYLE_ID  = 'surgeon-driver-style';
    var STYLE_CSS = [
        '.kernel-line.drv-ok   { color: #58d858; }',
        '.kernel-line.drv-warn { color: #cdb37a; }',
        '.kernel-line.drv-err  { color: #c47878; }',
        '.kernel-line.drv-panic      { color: #c08b8b; }',
        '.kernel-line.drv-panic-head { color: #ff8f8f; font-weight: bold; }',
        '.kernel-line.drv-panic-frame { color: #ff5f5f; font-weight: bold;',
        '    text-shadow: 0 0 6px rgba(255, 60, 60, 0.45); }',
        /* Разрядка плашке противопоказана: +1px на букву — это +134px на строке
         * (76 колонок отступа + 58 коробки), и баннер уезжает за правый ║. */
        '.kernel-line.drv-panic-banner { color: #ff2b2b; font-weight: bold;',
        '    letter-spacing: 0; text-shadow: 0 0 10px rgba(255, 40, 40, 0.6);',
        '    animation: drv-panic-blink 1.1s steps(1, end) infinite; }',
        '@keyframes drv-panic-blink { 0%, 54% { opacity: 1; } 55%, 100% { opacity: 0.4; } }',
        '.drv-watermark { position: absolute; right: 18px; bottom: 12px; z-index: 10002;',
        '    font-family: "Consolas", "Lucida Console", monospace; font-size: 12px;',
        '    color: #6e6e6e; opacity: 0; transition: opacity 1.2s linear;',
        '    pointer-events: none; user-select: none; letter-spacing: 1px; }',
        '.drv-watermark.drv-on { opacity: 0.62; }'
    ].join('\n');

    function injectStyles() {
        var node = document.getElementById(STYLE_ID);

        if (node) { return node; }
        if (!document.head) { return null; }

        node = document.createElement('style');
        node.id = STYLE_ID;
        node.textContent = STYLE_CSS;
        document.head.appendChild(node);
        return node;
    }

    /* --- 17. Подключение к ядру -------------------------------------------- */
    function installCommands() {
        var k = kernel();

        if (!k || typeof k.registerCommand !== 'function') { return false; }

        k.registerCommand('status', 'device driver status table', cmdStatus);
        k.registerCommand('devman', 'physical device tree with driver states', cmdDevman);
        k.registerCommand('sudo', 'install or remove a driver (install / del)', cmdSudo);
        k.registerCommand('beep', 'PC speaker burst, 800 Hz (audio driver required)', cmdBeep);
        return true;
    }

    /* Первое, что человек видит в shell: почему машина тормозит и что с ACPI.
     * Строки печатаются мгновенно — иначе предупреждение само попадёт под штраф. */
    function bootNotices() {
        var k = kernel();
        var arrow;

        if (noticesShown || !k || typeof k.printLine !== 'function') { return false; }
        noticesShown = true;

        if (!isInstalled('video')) {
            k.printLine('[ WARN ] video: no VGA driver — output penalty ' + VIDEO_LAG_MS +
                ' ms/char, viewport pinned to 640x480.', 'drv-warn');
            k.printLine('[ INFO ] fix it with: sudo install video (repository: ' +
                (repoReachable() ? 'online' : 'offline') + ')', 'is-dim');
        }
        if (unoptimized()) {
            k.printLine('[ WARN ] generic driver pack active — kernel speed -' +
                Math.round((AUTO_SLOWDOWN - 1) * 100) + '%.', 'drv-warn');
        }
        if (!isInstalled('acpi')) {
            k.printLine('[ WARN ] acpi: driver missing — no S5, no reset: shutdown, ' +
                'reboot and F5 are all dead.', 'drv-warn');
        }

        /* Мышь: указатель уже стоит на экране — говорим, каким драйвером он ходит. */
        if (isInstalled('mouse')) {
            arrow = pointerLine();
            k.printLine(arrow.text, arrow.cls);
        }
        return noticesShown;
    }

    /* Ядро поднимается позже нас: команды ставим на boot_complete, штрафы — когда
     * экран уже собран. Знак о штрафе вешаем только после shell, иначе его никто
     * не увидит: терминал во время загрузки скрыт. */
    function wire() {
        document.addEventListener('boot_complete', function () {
            noticesShown = false;
            installCommands();
        });

        document.addEventListener('kernel_boot_start', function () {
            noticesShown = false;
            installCommands();
        });

        document.addEventListener('kernel_boot_log_end', function () {
            applyPenalties(true);
            bootNotices();
        });

        document.addEventListener('kernel_ready', function () {
            applyPenalties(false);
            bootNotices();
        });

        /* Паника — не место для знака о драйверах: экран должен читаться. */
        document.addEventListener('kernel_panic', function () { toggleWatermark(false); });

        /* Перезагрузка поднимает ядро заново: штрафы вернём на новой загрузке. */
        document.addEventListener('surgeon_reboot', function () { noticesShown = false; });
        return true;
    }

    /* --- 18. Старт --------------------------------------------------------- */
    injectStyles();
    loadPack();
    installCommands();
    applyPenalties(true);          // знак о штрафе повиснет, когда поднимется shell
    wire();

    /* window.SurgeonDrivers — то, чем пользуются Setup, тесты и этап 5. */
    window.SurgeonDrivers = {
        version:      'Stage 4 · ' + PA_VERSION,
        nvramKey:     NVRAM_KEY,
        videoLagMs:   VIDEO_LAG_MS,
        autoSlowdown: AUTO_SLOWDOWN,
        beepHz:       BEEP_HZ,
        deviceIds:    ORDER.slice(0),
        devices:      snapshot,
        statusOf:     statusOf,
        isInstalled:  isInstalled,
        unoptimized:  unoptimized,
        table:        tableLines,
        tree:         treeLines,
        repoOnline:   repoReachable,
        force:        forceInstall,
        install:      installDriver,
        remove:       removeDriver,
        beep:         cmdBeep,
        panic:        acpiSabotage,
        panicBeeps:   function () { return panicBeepCount; },
        refresh:      refresh
    };

    console.log('[DRV] stage 4 loaded: ' + countStatus(STATUS.MISSING) + ' of ' +
        ORDER.length + ' devices without a driver, lag = ' +
        (isInstalled('video') ? 0 : VIDEO_LAG_MS) + ' ms/char, acpi = ' +
        (isInstalled('acpi') ? 'live' : 'missing'));
})(window, document);
