/* ============================================================================
 * Surgeon Kernel PA 0.1 (Pre-Alpha)    Файл: bios/click-bios/click-bios.js
 * ----------------------------------------------------------------------------
 * Click BIOS 5: оболочка Setup как на живом железе — меню сверху, плотные списки
 * опций вида "Option [Value]", панель System Status и Item Help справа, строка
 * функциональных клавиш снизу. Управление мышью и F10, ничего не анимируется.
 *
 * Читает объекты BIOS из window: TPABKA_REGISTRY (статус железа),
 * SurgeonDiskReady (разметка накопителя) и TPABKA_PROCESSES (чистится на входе
 * и выходе, чтобы не осталось живых интервалов).
 *
 * В localStorage лежат surgeon_boot_order (порядок загрузки) и surgeon_bios_oc
 * ({ voltage, multiplier }); surgeon_virtual_disk пишет POST, Setup только читает.
 *
 * API: SurgeonClickBios.init() / destroy()
 * ========================================================================== */
(function (window, document) {
    'use strict';

    var CONTAINER_ID   = 'surgeon-click-bios';
    var CONTENT_ID     = 'uefi-content';
    var HELP_ID        = 'uefi-help';
    var BOOT_ORDER_KEY = 'surgeon_boot_order';
    var OC_KEY         = 'surgeon_bios_oc';

    var DEFAULT_BOOT_ORDER = [
        'Live-USB Surgeon Flash Drive',
        'Surgeon Hard Disk (VDFS)'
    ];

    var DEFAULT_OC = { voltage: 1.032, multiplier: 36 };

    var OC_LIMITS = {
        multiplier: { min: 20,  max: 50,  step: 1     },
        voltage:    { min: 0.9, max: 1.4, step: 0.001 }
    };

    var CPU_TEMP   = 43;          // °C: датчик нарисован, железо тут не читается
    var SYS_TEMP   = 37;
    var KEY_F10    = 121;
    var BIOS_VER   = '5.20';
    var BIOS_BUILD = '10/10/2026';
    var BIOS_REV   = '0101';
    var DISK_KEY   = 'surgeon_virtual_disk';   // разметку диска пишет POST
    var CPU_MODEL  = 'Virtual Core i9 @3.60GHz';
    var BOARD_NAME = 'SURGEON Z990';

    /* --- 1. Вкладки и текст справки ---------------------------------------- */
    var TABS = [
        {
            id: 'settings',
            label: 'SETTINGS',
            help: 'Настройки платформы: порядок загрузки, режим SATA, USB и Secure Boot.'
        },
        {
            id: 'oc',
            label: 'OC (Overclocking)',
            help: 'Разгон: множитель ядра и напряжение. Профиль хранится в NVRAM.'
        },
        {
            id: 'hardware',
            label: 'HARDWARE MONITOR',
            help: 'Датчики температуры, обороты вентиляторов, частоты и напряжения.'
        },
        {
            id: 'mflash',
            label: 'M-FLASH',
            help: 'Обновление прошивки из файла образа. Работает только с USB-носителя.'
        },
        {
            id: 'exit',
            label: 'SAVE & EXIT',
            help: 'Сохранение изменений, сброс на умолчания и выход в загрузчик.'
        }
    ];

    /* --- 2. Состояние ------------------------------------------------------ */
    var state = {
        tab:        'settings',
        bootOrder:  [],
        oc:         {},
        container:  null,
        contentEl:  null,
        helpEl:     null,
        tabs:       [],      // [{ id, node }]
        clockEl:    null,
        voltEl:     null,
        ratioEl:    null,
        ocFlagEl:   null,    // живая строка "Overclocked" на вкладке OC
        ocStatusEl: null,    // она же в панели System Status
        clockTimer: null,
        keyHandler: null
    };

    /* --- 3. Хранилище ------------------------------------------------------ */
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
            // не сохранилось — интерфейс работает дальше
        }
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function loadBootOrder() {
        var stored = readJSON(BOOT_ORDER_KEY, null);

        if (!isArray(stored) || stored.length === 0) {
            writeJSON(BOOT_ORDER_KEY, DEFAULT_BOOT_ORDER);
            return DEFAULT_BOOT_ORDER.slice();
        }
        return stored.slice();
    }

    function loadOC() {
        var stored = readJSON(OC_KEY, null);

        if (!stored || typeof stored !== 'object') {
            writeJSON(OC_KEY, DEFAULT_OC);
            return { voltage: DEFAULT_OC.voltage, multiplier: DEFAULT_OC.multiplier };
        }

        return {
            voltage:    typeof stored.voltage    === 'number' ? stored.voltage    : DEFAULT_OC.voltage,
            multiplier: typeof stored.multiplier === 'number' ? stored.multiplier : DEFAULT_OC.multiplier
        };
    }

    /* --- 3a. Мосты к низкоуровневым службам BIOS -------------------------- */

    /* Реестр создаёт POST; если Setup открыли раньше — достраиваем сами. */
    function registry() {
        if (typeof window.TPABKA_ensureRegistry === 'function') {
            return window.TPABKA_ensureRegistry();
        }

        window.TPABKA_REGISTRY = window.TPABKA_REGISTRY || {
            hardware: {
                cpu:     { status: 'OK', microcode: '0x1A', overclocked: false },
                video:   { driver: '[NOT_INITIALIZED]', mode: 'Standard Text Mode', resolution: null },
                mouse:   { driver: '[NOT_INITIALIZED]', irq: 12 },
                usb_bus: { driver: '[NOT_INITIALIZED]', devices: [] },
                acpi:    { driver: '[NOT_INITIALIZED]', power_state: 'S0' },
                storage: { driver: '[NOT_INITIALIZED]', device: 'SURGEON_VDFS_SSD', partitions: [], ready: false }
            },
            system_flags: { is_safe_mode: false, kernel_ring: 0 }
        };
        return window.TPABKA_REGISTRY;
    }

    /* Разметку пишет POST: Setup только читает её и ничего не переформатирует. */
    function readDisk() {
        var disk = readJSON(DISK_KEY, null);

        if (disk && typeof disk === 'object' && isArray(disk.partitions)) { return disk; }
        return null;
    }

    /* Таблица процессов симулятора: чистится на входе в Setup и на выходе. */
    function resetProcesses() {
        if (typeof window.TPABKA_resetProcesses === 'function') {
            return window.TPABKA_resetProcesses();
        }

        var killed = isArray(window.TPABKA_PROCESSES) ? window.TPABKA_PROCESSES.length : 0;
        window.TPABKA_PROCESSES = [];
        return killed;
    }

    function processCount() {
        return isArray(window.TPABKA_PROCESSES) ? window.TPABKA_PROCESSES.length : 0;
    }

    function diskReadyText() {
        return (window.SurgeonDiskReady === true) ? 'true' : 'false';
    }

    function resolutionText(resolution) {
        if (!resolution) { return '[text mode]'; }
        return resolution.width + 'x' + resolution.height + 'x' + resolution.bpp;
    }

    function diskStatusText(disk) {
        if (!disk) { return '[NOT_FORMATTED]'; }
        return disk.label + ' (' + disk.partitions.length + ' partitions)';
    }

    /* --- 4. Мелкие хелперы ------------------------------------------------- */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (typeof text === 'string') { node.textContent = text; }
        return node;
    }

    function button(className, text) {
        var node = el('button', className, text);
        node.type = 'button';
        return node;
    }

    function formatVoltage(value) { return value.toFixed(3) + 'V'; }
    function formatRatio(value)   { return Math.round(value) + 'x'; }
    function formatTemp(value)    { return Math.round(value) + '\u00b0C'; }

    function pad2(value) {
        return value < 10 ? '0' + value : String(value);
    }

    function clearNode(node) {
        while (node.firstChild) { node.removeChild(node.firstChild); }
    }

    /* Полоса нагрузки рисуется символами, без градиентов. */
    function bar(percent, width) {
        var filled = Math.round((percent / 100) * width);
        var text = '';
        var i;

        if (filled < 0) { filled = 0; }
        if (filled > width) { filled = width; }

        for (i = 0; i < width; i++) {
            text += (i < filled) ? '\u2588' : '\u2591';
        }
        return '[' + text + ']';
    }

    /* --- 5. Строки списков ------------------------------------------------- */
    function biosRow(label, value) {
        var row = el('div', 'bios-row');
        row.appendChild(el('span', 'bios-row-label', label));
        row.appendChild(el('span', 'bios-row-value', value));
        return row;
    }

    function biosNote(text) {
        return el('div', 'bios-row-note', text);
    }

    function groupBox(title) {
        var box = el('div', 'bios-group');
        box.appendChild(el('div', 'bios-group-title', title));
        return box;
    }

    /* Строка с готовым узлом значения: нужна там, где значение живое. */
    function biosRowNode(label, valueNode) {
        var row = el('div', 'bios-row');
        row.appendChild(el('span', 'bios-row-label', label));
        row.appendChild(valueNode);
        return row;
    }

    function statusRowNode(label, valueNode) {
        var row = el('div', 'status-row');
        row.appendChild(el('span', 'status-label', label));
        row.appendChild(valueNode);
        return row;
    }

    /* Реестр знает про разгон: ядру важно, штатный ли режим у CPU. */
    function syncOverclockFlag() {
        var reg  = registry();
        var flag = (state.oc.multiplier !== DEFAULT_OC.multiplier) ||
                   (state.oc.voltage !== DEFAULT_OC.voltage);
        var text;

        reg.hardware.cpu.overclocked = flag;
        text = '[' + (flag ? 'Yes' : 'No') + ']';

        if (state.ocFlagEl)   { state.ocFlagEl.textContent   = text; }
        if (state.ocStatusEl) { state.ocStatusEl.textContent = flag ? 'Enabled' : 'Disabled'; }
    }

    function metric(label, valueNode) {
        var box = el('div', 'uefi-metric');
        box.appendChild(el('span', 'uefi-metric-label', label));
        box.appendChild(valueNode);
        return box;
    }

    /* --- 6. Каркас окна ---------------------------------------------------- */
    function buildHeader() {
        var header = el('div', 'uefi-header');
        var left   = el('div', 'uefi-header-left');
        var center = el('div', 'uefi-header-center');
        var right  = el('div', 'uefi-header-right');

        left.appendChild(el('span', 'uefi-logo', 'SURGEON CLICK BIOS 5'));
        left.appendChild(el('span', 'uefi-logo-sub',
            'PA 0.1  ·  Rev. ' + BIOS_REV + '  ·  ' + BIOS_BUILD));

        state.voltEl  = el('span', 'uefi-metric-value', formatVoltage(state.oc.voltage));
        state.ratioEl = el('span', 'uefi-metric-value', formatRatio(state.oc.multiplier));

        center.appendChild(metric('CPU TEMPERATURE',
            el('span', 'uefi-metric-value', formatTemp(CPU_TEMP))));
        center.appendChild(metric('CPU VOLTAGE', state.voltEl));
        center.appendChild(metric('CPU RATIO', state.ratioEl));
        center.appendChild(metric('MEMORY', el('span', 'uefi-metric-value', '4096 MB')));

        state.clockEl = el('span', 'uefi-clock', '--:--:--');
        right.appendChild(state.clockEl);

        var saveExit = button('uefi-save-exit', 'SAVE & EXIT (F10)');
        saveExit.addEventListener('click', function () { exitSetup(); });
        right.appendChild(saveExit);

        header.appendChild(left);
        header.appendChild(center);
        header.appendChild(right);
        return header;
    }

    function buildMenubar() {
        var bar = el('div', 'uefi-menubar');
        var i, node;

        state.tabs = [];

        for (i = 0; i < TABS.length; i++) {
            node = button('uefi-tab', TABS[i].label);
            node.setAttribute('data-tab', TABS[i].id);
            attachTab(node, TABS[i].id);

            bar.appendChild(node);
            state.tabs.push({ id: TABS[i].id, node: node });
        }
        return bar;
    }

    function attachTab(node, id) {
        node.addEventListener('click', function () { switchTab(id); });
    }

    function buildLegend() {
        var legend = el('div', 'uefi-legend');

        legend.appendChild(el('div', 'uefi-legend-keys',
            'F1:Help   ESC:Exit   \u2191\u2193:Select Item   ' +
            '\u2190\u2192:Change Value   F10:Save & Exit'));
        legend.appendChild(el('div', 'uefi-legend-build',
            'Click BIOS 5  \u00b7  Rev. ' + BIOS_REV + '  \u00b7  ' + BIOS_BUILD));

        return legend;
    }

    function buildShell() {
        var shell = el('div', 'uefi-shell');
        shell.id = CONTAINER_ID;

        state.contentEl = el('div', 'uefi-main');
        state.contentEl.id = CONTENT_ID;

        state.helpEl = el('div', 'uefi-help-box');
        state.helpEl.id = HELP_ID;

        var side = el('div', 'uefi-side');
        side.appendChild(buildStatusPanel());
        side.appendChild(state.helpEl);

        var body = el('div', 'uefi-body');
        body.appendChild(state.contentEl);
        body.appendChild(side);

        shell.appendChild(buildHeader());
        shell.appendChild(buildMenubar());
        shell.appendChild(body);
        shell.appendChild(buildLegend());
        return shell;
    }

    /* --- 7. Правая панель: System Status ---------------------------------- */
    function statusRow(label, value) {
        var row = el('div', 'status-row');
        row.appendChild(el('span', 'status-label', label));
        row.appendChild(el('span', 'status-value', value));
        return row;
    }

    function buildStatusPanel() {
        var box = el('div', 'uefi-status');
        box.appendChild(el('div', 'uefi-title', 'SYSTEM STATUS'));

        var reg  = registry();
        var disk = readDisk();

        state.ocStatusEl = el('span', 'status-value',
            reg.hardware.cpu.overclocked ? 'Enabled' : 'Disabled');

        box.appendChild(statusRow('BIOS Version', BIOS_VER));
        box.appendChild(statusRow('BIOS Build', BIOS_BUILD));
        box.appendChild(statusRow('BIOS Rev', BIOS_REV));
        box.appendChild(statusRow('Board', BOARD_NAME + ' (VDFS)'));
        box.appendChild(statusRow('Processor', CPU_MODEL));
        box.appendChild(statusRow('CPU Status', reg.hardware.cpu.status));
        box.appendChild(statusRow('Microcode', reg.hardware.cpu.microcode));
        box.appendChild(statusRowNode('Overclocking', state.ocStatusEl));
        box.appendChild(statusRow('Total Memory', '4096 MB DDR4-3200'));
        box.appendChild(statusRow('Storage', diskStatusText(disk)));
        box.appendChild(statusRow('pww13 Mount', '[/core/ /drivers/]'));
        box.appendChild(statusRow('vdfs Mount', '[/home/ /Versions/Apps/]'));
        box.appendChild(statusRow('Disk Ready', diskReadyText()));
        box.appendChild(statusRow('Boot Mode', 'UEFI / VDFS'));
        box.appendChild(statusRow('Secure Boot', 'Disabled'));
        box.appendChild(statusRow('VGA Driver', reg.hardware.video.driver));
        box.appendChild(statusRow('Video Mode', reg.hardware.video.mode));
        box.appendChild(statusRow('Resolution', resolutionText(reg.hardware.video.resolution)));
        box.appendChild(statusRow('Mouse Driver', reg.hardware.mouse.driver));
        box.appendChild(statusRow('Mouse IRQ', String(reg.hardware.mouse.irq)));
        box.appendChild(statusRow('USB Driver', reg.hardware.usb_bus.driver));
        box.appendChild(statusRow('USB Devices', String(reg.hardware.usb_bus.devices.length)));
        box.appendChild(statusRow('ACPI Driver', reg.hardware.acpi.driver));
        box.appendChild(statusRow('Power State', reg.hardware.acpi.power_state));
        box.appendChild(statusRow('Kernel Ring', String(reg.system_flags.kernel_ring)));
        box.appendChild(statusRow('Safe Mode', reg.system_flags.is_safe_mode ? 'On' : 'Off'));
        box.appendChild(statusRow('Processes', String(processCount())));
        box.appendChild(statusRow('CPU Temp', formatTemp(CPU_TEMP)));
        box.appendChild(statusRow('System Temp', formatTemp(SYS_TEMP)));
        box.appendChild(statusRow('CPU Fan', '1820 RPM'));

        return box;
    }

    /* --- 8. Вкладки и справка --------------------------------------------- */
    function switchTab(id) {
        var i;

        state.tab = id;

        for (i = 0; i < state.tabs.length; i++) {
            state.tabs[i].node.className =
                (state.tabs[i].id === id) ? 'uefi-tab active' : 'uefi-tab';
        }

        clearNode(state.contentEl);
        renderHelp(id);

        if (id === 'settings') {
            renderSettings();
        } else if (id === 'oc') {
            renderOC();
        } else if (id === 'hardware') {
            renderHardware();
        } else if (id === 'mflash') {
            renderMFlash();
        } else {
            renderExit();
        }
    }

    function renderHelp(id) {
        var i;

        clearNode(state.helpEl);
        state.helpEl.appendChild(el('div', 'uefi-help-title', 'ITEM HELP'));

        for (i = 0; i < TABS.length; i++) {
            if (TABS[i].id === id) {
                state.helpEl.appendChild(el('div', 'uefi-help-text', TABS[i].help));
            }
        }
        state.helpEl.appendChild(el('div', 'uefi-help-text',
            'Значение сохраняется в NVRAM сразу при изменении.'));
    }

    /* --- 9. Вкладка SETTINGS ---------------------------------------------- */
    function renderSettings() {
        var content = state.contentEl;
        var boot, storage, usb, secure, diskBox, diskState, reg, part, i;

        content.appendChild(el('h2', 'uefi-title', 'SETTINGS'));

        boot = groupBox('Boot Configuration');
        for (i = 0; i < state.bootOrder.length; i++) {
            boot.appendChild(buildBootItem(i));
        }
        boot.appendChild(biosNote(
            'Стрелки ↑ / ↓ меняют приоритет загрузки. Значение пишется в NVRAM сразу.'));
        content.appendChild(boot);

        storage = groupBox('Storage Configuration');
        storage.appendChild(biosRow('SATA Mode Selection', '[AHCI]'));
        storage.appendChild(biosRow('SATA Port 0', '[SURGEON_VDFS_SSD 512GB]'));
        storage.appendChild(biosRow('SATA Port 1', '[SURGEON_OPTICAL_DVD-RW]'));
        storage.appendChild(biosRow('VDFS Bridge', '[Enabled]'));
        content.appendChild(storage);

        /* Разметку накопителя показываем как есть: Setup тут ничего не меняет. */
        diskState = readDisk();
        reg       = registry();

        diskBox = groupBox('Virtual Disk (JSON-FS)');
        diskBox.appendChild(biosRow('Disk Label',
            '[' + ((diskState && diskState.label) || 'SURGEON_VDFS_SSD') + ']'));
        diskBox.appendChild(biosRow('SurgeonDiskReady', '[' + diskReadyText() + ']'));
        diskBox.appendChild(biosRow('Storage Driver', '[' + reg.hardware.storage.driver + ']'));

        if (diskState) {
            for (i = 0; i < diskState.partitions.length; i++) {
                part = diskState.partitions[i];
                diskBox.appendChild(biosRow('Partition ' + (i + 1),
                    '[' + part.fs + ' ' + part.size_mb + 'MB ' + part.status + ']'));
                diskBox.appendChild(biosRow('  Mount', '[' + part.mount_points.join(' ') + ']'));
                diskBox.appendChild(biosRow('  FS Type',
                    '[' + (part.protected ? 'protected' : 'writable') + ']'));
            }
            diskBox.appendChild(biosNote(
                'pww13 -> /core/ /drivers/, vdfs -> /home/ /Versions/Apps/. Разметку пишет BIOS при POST.'));
        } else {
            diskBox.appendChild(biosRow('Partition Table', '[NOT_FORMATTED]'));
            diskBox.appendChild(biosNote(
                'Разметка не найдена. Перезагрузите машину: POST разметит накопитель сам.'));
        }
        content.appendChild(diskBox);

        usb = groupBox('USB Configuration');
        usb.appendChild(biosRow('Legacy USB Support', '[Enabled]'));
        usb.appendChild(biosRow('XHCI Hand-off', '[Enabled]'));
        usb.appendChild(biosRow('USB Mass Storage Driver', '[Enabled]'));
        usb.appendChild(biosRow('USB Devices Found', '1 Keyboard, 1 Mouse'));
        content.appendChild(usb);

        secure = groupBox('Secure Boot');
        secure.appendChild(biosRow('Secure Boot', '[Disabled]'));
        secure.appendChild(biosRow('Platform Key (PK)', '[Not Installed]'));
        secure.appendChild(biosRow('Boot Mode', '[UEFI / VDFS]'));
        secure.appendChild(biosRow('Fast Boot', '[Disabled]'));
        content.appendChild(secure);
    }

    /* Пункт порядка загрузки: слот, имя устройства, стрелки ↑ и ↓. */
    function buildBootItem(index) {
        var item   = el('div', 'boot-item');
        var arrows = [];
        var up, down, i;

        item.appendChild(el('span', 'boot-slot', 'Boot Option #' + (index + 1)));
        item.appendChild(el('span', 'boot-name', state.bootOrder[index]));

        up   = button('boot-arrow', '↑');
        down = button('boot-arrow', '↓');
        arrows.push(up);
        arrows.push(down);

        for (i = 0; i < arrows.length; i++) {
            if ((i === 0 && index === 0) ||
                (i === 1 && index === state.bootOrder.length - 1)) {
                arrows[i].className = 'boot-arrow disabled';
                arrows[i].disabled  = true;
            }
            item.appendChild(arrows[i]);
        }

        up.addEventListener('click', function () { moveBoot(index, -1); });
        down.addEventListener('click', function () { moveBoot(index, 1); });
        return item;
    }

    function moveBoot(index, delta) {
        var target = index + delta;
        var swap;

        if (target < 0 || target >= state.bootOrder.length) { return; }

        swap = state.bootOrder[index];
        state.bootOrder[index]  = state.bootOrder[target];
        state.bootOrder[target] = swap;

        writeJSON(BOOT_ORDER_KEY, state.bootOrder);
        switchTab('settings');      // список перерисовывается целиком, одним кадром
    }

    /* --- 10. Вкладка OC ---------------------------------------------------- */
    function renderOC() {
        var content = state.contentEl;
        var ratio, volt, extra;

        content.appendChild(el('h2', 'uefi-title', 'OC (OVERCLOCKING)'));

        ratio = groupBox('CPU Ratio Settings');
        ratio.appendChild(sliderRow('CPU Ratio', 'multiplier'));
        content.appendChild(ratio);

        volt = groupBox('CPU Core Voltage');
        volt.appendChild(sliderRow('CPU Core Voltage', 'voltage'));
        content.appendChild(volt);

        extra = groupBox('Frequency / Voltage Control');
        state.ocFlagEl = el('span', 'bios-row-value', '[No]');
        extra.appendChild(biosRow('CPU Status', '[' + registry().hardware.cpu.status + ']'));
        extra.appendChild(biosRow('Microcode', '[' + registry().hardware.cpu.microcode + ']'));
        extra.appendChild(biosRowNode('Overclocked', state.ocFlagEl));
        extra.appendChild(biosRow('CPU Base Clock', '[100.00 MHz]'));
        extra.appendChild(biosRow('Turbo Mode', '[Enabled]'));
        extra.appendChild(biosRow('Load-Line Calibration', '[Auto]'));
        extra.appendChild(biosRow('XMP Profile', '[Profile 1: DDR4-3200]'));
        extra.appendChild(biosRow('OC Profile (NVRAM)', '[surgeon_bios_oc]'));
        extra.appendChild(biosNote(
            'Разгон — на свой риск: датчики врут, потому что железо виртуальное.'));
        content.appendChild(extra);

        syncOverclockFlag();      // строка "Overclocked" берёт значение реестра
    }

    /* Строка OC: подпись, ползунок, кнопки шага и цифровое значение. */
    function sliderRow(title, field) {
        var limits    = OC_LIMITS[field];
        var formatter = (field === 'voltage') ? formatVoltage : formatRatio;
        var row       = el('div', 'oc-row');
        var input     = el('input', 'oc-range');
        var readout   = el('span', 'oc-value', formatter(state.oc[field]));
        var minus     = button('oc-step', '\u2212');
        var plus      = button('oc-step', '+');

        input.type  = 'range';
        input.min   = String(limits.min);
        input.max   = String(limits.max);
        input.step  = String(limits.step);
        input.value = String(state.oc[field]);

        input.addEventListener('input', function () {
            applyOC(field, parseFloat(input.value), readout, formatter);
        });
        minus.addEventListener('click', function () { bumpOC(field, -1, input); });
        plus.addEventListener('click', function () { bumpOC(field, 1, input); });

        row.appendChild(el('span', 'oc-row-title', title));
        row.appendChild(input);
        row.appendChild(minus);
        row.appendChild(plus);
        row.appendChild(readout);
        return row;
    }

    /* Кнопки + / − двигают значение на шаг, как клавиши в настоящем Setup. */
    function bumpOC(field, direction, input) {
        var limits = OC_LIMITS[field];
        var next   = parseFloat(input.value) + (direction * limits.step);
        var fixed  = (field === 'voltage') ? Math.round(next * 1000) / 1000 : Math.round(next);

        if (fixed < limits.min || fixed > limits.max) { return; }

        input.value = String(fixed);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function applyOC(field, value, readout, formatter) {
        var limits = OC_LIMITS[field];

        if (isNaN(value)) { return; }

        if (value < limits.min) { value = limits.min; }
        if (value > limits.max) { value = limits.max; }
        if (field === 'multiplier') { value = Math.round(value); }
        if (field === 'voltage')    { value = Math.round(value * 1000) / 1000; }

        state.oc[field] = value;
        readout.textContent = formatter(value);
        updateMetrics();
        writeJSON(OC_KEY, state.oc);
        syncOverclockFlag();      // реестр узнаёт про разгон сразу
    }

    /* Напряжение и множитель видны ещё и в шапке — держим цифры синхронно. */
    function updateMetrics() {
        if (state.voltEl)  { state.voltEl.textContent  = formatVoltage(state.oc.voltage); }
        if (state.ratioEl) { state.ratioEl.textContent = formatRatio(state.oc.multiplier); }
    }

    /* --- 11. Вкладка HARDWARE MONITOR ------------------------------------- */
    function renderHardware() {
        var content = state.contentEl;
        var temps, fans, freqs;

        content.appendChild(el('h2', 'uefi-title', 'HARDWARE MONITOR'));

        temps = groupBox('Temperatures');
        temps.appendChild(hwRow('CPU Temperature', formatTemp(CPU_TEMP), 43));
        temps.appendChild(hwRow('System Temperature', formatTemp(SYS_TEMP), 30));
        temps.appendChild(hwRow('VRM Temperature', formatTemp(41), 35));
        temps.appendChild(hwRow('CPU Package (TjMax 100°C)', formatTemp(CPU_TEMP + 6), 49));
        content.appendChild(temps);

        fans = groupBox('Fans');
        fans.appendChild(hwRow('CPU Fan', '1820 RPM', 62));
        fans.appendChild(hwRow('System Fan 1', '1210 RPM', 45));
        fans.appendChild(hwRow('System Fan 2', '0 RPM', 0));
        content.appendChild(fans);

        freqs = groupBox('Frequencies and Voltages');
        freqs.appendChild(biosRow('CPU Base Clock', '[100.00 MHz]'));
        freqs.appendChild(biosRow('CPU Ratio', '[' + state.oc.multiplier + 'x]'));
        freqs.appendChild(biosRow('CPU Frequency', '[' + (state.oc.multiplier * 100) + ' MHz]'));
        freqs.appendChild(biosRow('CPU Core Voltage', '[' + formatVoltage(state.oc.voltage) + ']'));
        freqs.appendChild(biosRow('Memory Frequency', '[1600 MHz (DDR4-3200)]'));
        content.appendChild(freqs);
    }

    /* Строка датчика: подпись, символьная полоса загрузки и значение. */
    function hwRow(label, value, percent) {
        var row = el('div', 'bios-row');
        row.appendChild(el('span', 'bios-row-label', label));
        row.appendChild(el('span', 'hw-bar', bar(percent, 16)));
        row.appendChild(el('span', 'bios-row-value', value));
        return row;
    }

    /* --- 12. Вкладка M-FLASH: заглушка ------------------------------------ */
    function renderMFlash() {
        var content = state.contentEl;
        var box, pick;

        content.appendChild(el('h2', 'uefi-title', 'M-FLASH'));

        box = el('div', 'mflash-box');
        box.appendChild(el('pre', 'mflash-ascii',
            '    +-----------------+\n' +
            '    |  SURGEON  USB   |\n' +
            '    +-----------------+\n' +
            '    | ##############  |\n' +
            '    | --------------  |\n' +
            '    +-----------------+\n' +
            '        |       |\n' +
            '     RESET    PROBE'));

        box.appendChild(el('div', 'mflash-badge', 'USB 3.2 / VDFS'));
        box.appendChild(el('div', 'mflash-text',
            'M-Flash Mode. Ready for flash system via /dev/ports. Select ROM file...'));
        box.appendChild(el('div', 'mflash-note',
            'Step 1. Insert a USB flash drive with the ROM image.'));
        box.appendChild(el('div', 'mflash-note',
            'Step 2. Press "Select ROM file" and pick the image.'));
        box.appendChild(el('div', 'mflash-note',
            'Step 3. Wait for "Flash Update Complete", then reboot.'));
        box.appendChild(el('div', 'mflash-note',
            'Current ROM: PA 0.1 Rev. ' + BIOS_REV + ' (' + BIOS_BUILD + ')'));

        pick = button('mflash-btn', 'Select ROM file');
        pick.disabled = true;
        box.appendChild(pick);

        content.appendChild(box);
    }

    /* --- 13. Вкладка SAVE & EXIT ------------------------------------------ */
    function renderExit() {
        var content = state.contentEl;
        var list, override, i;

        content.appendChild(el('h2', 'uefi-title', 'SAVE & EXIT'));

        list = el('div', 'exit-list');
        list.appendChild(exitButton('Save Changes and Reset', true, function () {
            exitSetup();
        }));
        list.appendChild(exitButton('Discard Changes and Reset', false, function () {
            restoreDefaults();
            exitSetup();
        }));
        list.appendChild(exitButton('Restore Defaults', false, function () {
            restoreDefaults();
            switchTab('exit');
        }));
        list.appendChild(exitButton('Boot Override: Live-USB Surgeon Flash Drive', false,
            function () { exitSetup(); }));
        content.appendChild(list);

        override = groupBox('Boot Override / NVRAM');
        for (i = 0; i < state.bootOrder.length; i++) {
            override.appendChild(biosRow('Override #' + (i + 1),
                '[' + state.bootOrder[i] + ']'));
        }
        override.appendChild(biosRow('NVRAM surgeon_boot_order', '[saved]'));
        override.appendChild(biosRow('NVRAM surgeon_bios_oc', '[saved]'));
        override.appendChild(biosRow('SurgeonDiskReady', '[' + diskReadyText() + ']'));
        override.appendChild(biosRow('Process Table', '[' + processCount() + ' active]'));
        override.appendChild(biosNote(
            'Save & Exit обнуляет window.TPABKA_PROCESSES и перезагружает машину.'));
        override.appendChild(biosNote(
            'Setup не держит черновик: значения пишутся в NVRAM сразу.'));
        content.appendChild(override);
    }

    function exitButton(label, primary, handler) {
        var node = button('exit-btn' + (primary ? ' is-primary' : ''), label);
        node.addEventListener('click', handler);
        return node;
    }

    /* Сброс к умолчаниям: и память модуля, и записи NVRAM. */
    function restoreDefaults() {
        state.bootOrder = DEFAULT_BOOT_ORDER.slice();
        state.oc        = {
            voltage:    DEFAULT_OC.voltage,
            multiplier: DEFAULT_OC.multiplier
        };

        writeJSON(BOOT_ORDER_KEY, DEFAULT_BOOT_ORDER);
        writeJSON(OC_KEY, DEFAULT_OC);
        updateMetrics();
        syncOverclockFlag();          // реестр: разгон выключен
    }

    /* --- 14. Часы в шапке -------------------------------------------------- */
    function tickClock() {
        if (!state.clockEl) { return; }

        var now = new Date();
        state.clockEl.textContent =
            pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    }

    /* --- 15. Выход и точка входа ------------------------------------------ */
    /* Save & Exit = мягкая перезагрузка: RAM симулятора чистится целиком. */
    function exitSetup() {
        var killed = resetProcesses();

        console.log('[CLICK BIOS] Save & Exit: ' + killed +
            ' process(es) killed, process table cleared');
        destroy();
        window.location.reload();      // стартуем заново, уже с новым порядком
    }

    function destroy() {
        if (state.clockTimer) {
            window.clearInterval(state.clockTimer);
            state.clockTimer = null;
        }
        if (state.keyHandler) {
            window.removeEventListener('keydown', state.keyHandler, true);
            state.keyHandler = null;
        }
        if (state.container && state.container.parentNode) {
            state.container.parentNode.removeChild(state.container);
        }

        state.container = null;
        state.contentEl = null;
        state.helpEl    = null;
        state.clockEl   = null;
        state.voltEl    = null;
        state.ratioEl   = null;
        state.ocFlagEl  = null;
        state.ocStatusEl = null;
        state.tabs      = [];
    }

    function init() {
        destroy();                     // повторный вход начинается с чистого листа

        /* Обнуляем диспетчер задач симулятора. */
        console.log('[CLICK BIOS] init: process table reset (' + resetProcesses() + ' killed)');

        state.bootOrder = loadBootOrder();
        state.oc        = loadOC();

        registry();                    // реестр BIOS обязан существовать до отрисовки
        syncOverclockFlag();

        state.container = buildShell();
        document.body.appendChild(state.container);

        tickClock();
        state.clockTimer = window.setInterval(tickClock, 1000);

        state.keyHandler = function (event) {
            var code = event.keyCode || event.which;
            if (code === KEY_F10 || event.key === 'F10') {
                event.preventDefault();
                exitSetup();
            }
        };
        window.addEventListener('keydown', state.keyHandler, true);

        switchTab('settings');
    }

    window.SurgeonClickBios = {
        init:    init,
        destroy: destroy
    };
})(window, document);
