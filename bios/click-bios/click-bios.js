/* ============================================================================
 * Surgeon Kernel PA 0.3    Файл: bios/click-bios/click-bios.js
 * ----------------------------------------------------------------------------
 * Click BIOS 5: Setup как на живом железе — меню сверху, плотные списки опций
 * вида "Option [Value]", панель System Status и Item Help справа, строка
 * функциональных клавиш снизу. Мышь, F10 и стрелки; анимаций нет.
 *
 * Каждый клик имеет последствия:
 *   Setup Checklist — флешка в Boot Option #1, XMP включён, VDFS Bridge
 *                     [Enabled]: без этих трёх пунктов POST не пустит машину
 *                     дальше и через 2 сек вернёт вас сюда же;
 *   Boot Priority   — VDFS первым без установленных сборок роняет машину в
 *                     "No Bootable Device" (выход — F5 или <Del> x5 в Setup);
 *   Разгон CPU      — множитель и напряжение: правильные значения реально
 *                     ускоряют POST и GRUB, запредельные — минус 30% частоты;
 *   Разгон памяти   — XMP-профиль или ручные частота/напряжение/тайминги:
 *                     за лимитами память нестабильна, экран сыплется;
 *   SATA Mode       — IDE тормозит I/O ядра на 30% (io_throttle = 0.7);
 *   Legacy USB      — Disabled вырубает клавиатуру в меню GRUB;
 *   Secure Boot     — Enabled требует подписанный дистрибутив (решает GRUB).
 *
 * Артефакты перегрева появляются только после Save & Exit: в самом Setup
 * экран чистый, о проблеме говорит красная полоса внизу.
 *
 * Аварийные выходы (Ctrl+Alt+R и кнопка COOL DOWN) снимают разгон за лимитами
 * и журнал перегрева, но НЕ трогают чек-лист: XMP и порядок загрузки остаются
 * на месте — иначе из перегрева человек попадал в цикл Setup -> POST.
 *
 * NVRAM (localStorage) — контракт с POST, GRUB и ядром:
 *   surgeon_boot_order     [ 'Live-USB ...', 'Surgeon Hard Disk (VDFS)' ]
 *   surgeon_bios_oc        { voltage, multiplier }
 *   surgeon_bios_memory    { xmp, freq_mhz, dram_voltage, cl }
 *   surgeon_bios_storage   { sata_mode: 'AHCI' | 'IDE', vdfs_bridge }
 *   surgeon_bios_usb       { legacy_usb: true | false }
 *   surgeon_bios_security  { secure_boot: true | false }
 *   surgeon_bios_overheat  { armed, active, voltage, multiplier, memory, cooling, reason }
 *   surgeon_installed_distros / surgeon_driver_pack / surgeon_virtual_disk
 *
 * Наружу отдаёт SurgeonClickBios, SurgeonOverheat (движок артефактов, им же
 * пользуется POST), SurgeonBootGuard и SurgeonSetupCheck (чек-лист для POST).
 *
 * API: SurgeonClickBios.init() / destroy() / save() / exit() / reload()
 *      SurgeonOverheat.start(rootEl) / stop() / .state() / .record() / .armed()
 *      SurgeonSetupCheck.pending() / .total() / .all()
 * ========================================================================== */
(function (window, document) {
    'use strict';

    var CONTAINER_ID   = 'surgeon-click-bios';
    var CONTENT_ID     = 'uefi-content';
    var HELP_ID        = 'uefi-help';
    var NOBOOT_ID      = 'surgeon-no-boot-device';

    /* --- Ключи NVRAM: их читают POST, GRUB и будущее ядро ------------------ */
    var BOOT_ORDER_KEY = 'surgeon_boot_order';
    var OC_KEY         = 'surgeon_bios_oc';
    var MEMORY_KEY     = 'surgeon_bios_memory';
    var SATA_KEY       = 'surgeon_bios_storage';
    var USB_KEY        = 'surgeon_bios_usb';
    var SECURE_KEY     = 'surgeon_bios_security';
    var OVERHEAT_KEY   = 'surgeon_bios_overheat';
    var DRIVER_KEY     = 'surgeon_driver_pack';        // ставит менеджер драйверов
    var DISTRO_KEY     = 'surgeon_installed_distros';  // тот же ключ, что у GRUB
    var DISK_KEY       = 'surgeon_virtual_disk';       // разметку пишет POST

    /* Устройства загрузки: их двигают стрелки, выбирает Boot Override. */
    var DEV_USB    = 'Live-USB Surgeon Flash Drive';
    var DEV_VDFS   = 'Surgeon Hard Disk (VDFS)';
    var BOOT_DEVICES       = [DEV_USB, DEV_VDFS];
    var DEFAULT_BOOT_ORDER = [DEV_USB, DEV_VDFS];

    var DEFAULT_OC = { voltage: 1.032, multiplier: 36 };

    var OC_LIMITS = {
        multiplier: { min: 20,  max: 50,  step: 1     },
        voltage:    { min: 0.9, max: 1.4, step: 0.001 }
    };

    /* Красная зона разгона: за ней без драйверов охлаждения будет перегрев. */
    var SAFE_OC = { voltage: 1.35, multiplier: 45 };

    /* --- 0a. Память: XMP-профиль или ручные частоты ------------------------- */
    /* Профили XMP — как на живом железе: узкие, предсказуемые, в паспорте. */
    var DEFAULT_MEMORY = { xmp: 'Disabled', freq_mhz: 3200, dram_voltage: 1.2, cl: 16 };

    var XMP_PROFILES = {
        'Disabled':              { freq_mhz: 3200, dram_voltage: 1.2,  cl: 16 },
        'Profile 1: DDR4-3200':  { freq_mhz: 3200, dram_voltage: 1.25, cl: 16 },
        'Profile 2: DDR4-3600':  { freq_mhz: 3600, dram_voltage: 1.35, cl: 18 }
    };

    var XMP_VALUES = ['Disabled', 'Profile 1: DDR4-3200', 'Profile 2: DDR4-3600', 'Manual'];

    /* Ручной разгон памяти: за этими цифрами контроллер уже не держит планку. */
    var MEM_LIMITS = {
        freq_mhz:     { min: 2400, max: 4800, step: 200   },
        dram_voltage: { min: 1.2,  max: 1.6,  step: 0.005 },
        cl:           { min: 12,   max: 24,   step: 1     }
    };

    var SAFE_MEM = { freq_mhz: 3600, dram_voltage: 1.35, cl: 20 };

    var DEFAULT_SATA   = { sata_mode: 'AHCI', vdfs_bridge: true };
    var DEFAULT_USB    = { legacy_usb: true };
    var DEFAULT_SECURE = { secure_boot: false };

    /* Артефакты перегрева — нарочно слабые: дрожит треть узлов, раз в тик по
     * экрану проходят цветные полосы, как на умирающей плате. Селектор общий:
     * движок трясёт и Setup, и экран POST, и меню GRUB. */
    var GLITCH_TICK_MS  = 160;
    var GLITCH_RATIO    = 0.34;
    var GLITCH_BARS     = { min: 2, max: 5 };        // столько полос за тик
    var GLITCH_COLORS   = ['#00ffff', '#ff00ff', '#ffff00', '#ff2d2d', '#00ff66', '#5f7cff'];
    var GLITCH_SELECTOR = '.bios-row, .bios-group-title, .oc-row, .uefi-title, ' +
        '.uefi-tab, .status-row, .boot-item, .uefi-logo, .uefi-metric, .exit-btn, .bios-row-note, ' +
        '.post-head-line, .post-head-art, .post-head-caption, .post-line, .post-splash-frame, ' +
        '.post-logo, .post-art, .post-splash-sub, .post-splash-perf, .post-hint, .post-thermal, ' +
        '.post-error-head, .post-error-line, .post-error-foot, ' +
        '.grub-banner-line, .grub-row, .grub-notice-line';

    var CPU_TEMP   = 43;          // °C: датчик нарисован, железо тут не читается
    var SYS_TEMP   = 37;
    var KEY_F10    = 121;
    var KEY_F5     = 116;
    var KEY_R      = 82;
    var KEY_ESC    = 27;
    var KEY_DELETE = 46;
    var DEL_PRESSES = 5;          // столько <Del> открывает Setup и с экрана отказа
    var PA_VERSION = 'PA 0.3';
    var BIOS_VER   = '5.20';
    var BIOS_BUILD = '10/10/2026';
    var BIOS_REV   = '0101';
    var CPU_MODEL  = 'Virtual Core i9 @3.60GHz';
    var BOARD_NAME = 'SURGEON Z990';

    /* --- 1. Вкладки и текст справки ---------------------------------------- */
    var TABS = [
        {
            id: 'settings',
            label: 'SETTINGS',
            help: 'Порядок загрузки, режим SATA, USB и Secure Boot. Пункты чек-листа обязательны.'
        },
        {
            id: 'oc',
            label: 'OC (Overclocking)',
            help: 'Разгон CPU и памяти: множитель, напряжение, XMP или ручные частоты DRAM.'
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
        mem:        {},
        storage:    { sata_mode: 'AHCI', vdfs_bridge: true },
        usb:        { legacy_usb: true },
        security:   { secure_boot: false },
        container:  null,
        contentEl:  null,
        helpEl:     null,
        tabs:       [],      // [{ id, node }]
        clockEl:    null,
        voltEl:     null,
        ratioEl:    null,
        memMetricEl: null,   // живая строка "MEMORY" в шапке
        ocFlagEl:   null,    // живая строка "Overclocked" на вкладке OC
        ocStatusEl: null,    // она же в панели System Status
        memStatusEl: null,   // строка "Memory Status" там же
        clockTimer: null,
        /* Живые узлы правой панели: их переписывают сеттеры флагов. */
        statusBootEl:    null,   // строка "Boot Option #1" там же
        statusSataEl:    null,
        statusUsbEl:     null,
        statusSecureEl:  null,
        statusThermalEl: null,
        statusCheckEl:   null,   // строка "Setup Checklist" там же
        checkRowEls:     {},     // строки чек-листа на вкладке SETTINGS
        thermalEl:       null,   // строка "Thermal Override" на вкладке OC
        thermalCauseEl:  null,   // причина перегрева там же
        memUnstableEl:   null,   // строка "Memory Status" на вкладке OC
        noticeEl:        null,   // подтверждение последнего клика
        bannerEl:        null,   // красная полоса аварийного режима
        setupBannerEl:   null,   // полоса "SETUP REQUIRED" под меню
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

    /* --- 3a. Платформенные настройки: SATA, USB, Secure Boot --------------- */
    /* Всё лежит в NVRAM: Setup пишет, POST/GRUB/ядро читают. */
    function boolLabel(flag) {
        return flag ? 'Enabled' : 'Disabled';
    }
    function loadPlatformSettings() {
        var sata   = readJSON(SATA_KEY, null);
        var usb    = readJSON(USB_KEY, null);
        var secure = readJSON(SECURE_KEY, null);

        state.storage = {
            sata_mode:   (sata && sata.sata_mode === 'IDE') ? 'IDE' : 'AHCI',
            vdfs_bridge: !(sata && sata.vdfs_bridge === false)
        };
        state.usb      = { legacy_usb: !(usb && usb.legacy_usb === false) };
        state.security = { secure_boot: !!(secure && secure.secure_boot === true) };

        /* Первый вход: записей ещё нет — заливаем умолчания. */
        if (!sata)   { writeJSON(SATA_KEY, state.storage); }
        if (!usb)    { writeJSON(USB_KEY, state.usb); }
        if (!secure) { writeJSON(SECURE_KEY, state.security); }
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

    /* --- 3b. Память: XMP-профиль или ручные частоты ----------------------- */
    function loadMemory() {
        var stored = readJSON(MEMORY_KEY, null);
        var mem    = {
            xmp:          DEFAULT_MEMORY.xmp,
            freq_mhz:     DEFAULT_MEMORY.freq_mhz,
            dram_voltage: DEFAULT_MEMORY.dram_voltage,
            cl:           DEFAULT_MEMORY.cl
        };

        if (stored && typeof stored === 'object') {
            if (typeof stored.xmp === 'string' && indexOfValue(XMP_VALUES, stored.xmp) !== -1) {
                mem.xmp = stored.xmp;
            }
            if (typeof stored.freq_mhz === 'number')     { mem.freq_mhz     = stored.freq_mhz;     }
            if (typeof stored.dram_voltage === 'number') { mem.dram_voltage = stored.dram_voltage; }
            if (typeof stored.cl === 'number')           { mem.cl           = stored.cl;           }
        } else {
            writeJSON(MEMORY_KEY, mem);      // первый вход: заливаем умолчания
        }

        return mem;
    }

    function memoryProfile() {
        return (state.mem && typeof state.mem.freq_mhz === 'number') ? state.mem : loadMemory();
    }

    /* Ручной профиль за лимитами или дикое напряжение: память нестабильна. */
    function memoryState() {
        var mem     = memoryProfile();
        var reasons = [];
        var manual  = (mem.xmp === 'Manual');

        if (manual && mem.freq_mhz > SAFE_MEM.freq_mhz) {
            reasons.push('DRAM FREQUENCY ' + mem.freq_mhz + 'MHz > LIMIT ' + SAFE_MEM.freq_mhz + 'MHz');
        }
        if (mem.dram_voltage > SAFE_MEM.dram_voltage) {
            reasons.push('DRAM VOLTAGE ' + formatVoltage(mem.dram_voltage) +
                ' > LIMIT ' + formatVoltage(SAFE_MEM.dram_voltage));
        }
        if (manual && mem.cl > SAFE_MEM.cl) {
            reasons.push('CAS LATENCY CL' + mem.cl + ' > LIMIT CL' + SAFE_MEM.cl);
        }

        return {
            xmp:      mem.xmp,
            freq_mhz: mem.freq_mhz,
            clock:    Math.round(mem.freq_mhz / 2),
            voltage:  mem.dram_voltage,
            cl:       mem.cl,
            manual:   manual,
            unstable: reasons.length > 0,
            text:     reasons.length ? reasons.join('  \u00b7  ') : 'Stable',
            reasons:  reasons
        };
    }

    /* Профиль XMP подставляет паспортные частоты; Manual — цифры вручную. */
    function applyXmp(profile) {
        var preset;

        state.mem.xmp = profile;

        if (profile !== 'Manual') {
            preset = XMP_PROFILES[profile] || XMP_PROFILES['Disabled'];
            state.mem.freq_mhz     = preset.freq_mhz;
            state.mem.dram_voltage = preset.dram_voltage;
            state.mem.cl           = preset.cl;
        }

        writeJSON(MEMORY_KEY, state.mem);
        syncOverclockFlag();
        evaluateThermal();

        if (state.tab === 'oc') { switchTab('oc'); }   // ползунки показывают новые цифры

        showNotice(profile === 'Manual'
            ? 'XMP [Manual]: частоту, напряжение и тайминги задаёте сами — за лимитами память нестабильна.'
            : 'XMP [' + profile + ']: ' + state.mem.freq_mhz + 'MHz (DDR4-' + state.mem.freq_mhz + ')  ' +
              formatVoltage(state.mem.dram_voltage) + '  CL' + state.mem.cl + '.');
    }

    /* Скорость памяти — для панели статуса и строки Overclocked. */
    function memoryOverclocked() {
        var mem = memoryState();

        return (mem.freq_mhz !== DEFAULT_MEMORY.freq_mhz) ||
            (mem.dram_voltage !== DEFAULT_MEMORY.dram_voltage) ||
            (mem.cl !== DEFAULT_MEMORY.cl);
    }

    /* Ускорение считает POST (SurgeonPerf): здесь только показываем цифру. */
    function speedBoostText() {
        var api = window.SurgeonPerf;

        if (api && typeof api.speed === 'function') {
            return 'x' + api.speed() + ' к скорости POST и GRUB';
        }
        return 'x' + (state.oc.multiplier / DEFAULT_OC.multiplier).toFixed(2) + ' (POST молчит)';
    }

    /* --- 3c. Перегрев: драйверы охлаждения, лимиты, журнал NVRAM ---------- */
    /* Драйверы охлаждения ставит менеджер драйверов (этап 12): пока ключ
     * surgeon_driver_pack пуст, железо считается необдуваемым. */
    function coolingDriversInstalled() {
        var pack = readJSON(DRIVER_KEY, null);
        var list = null;
        var i;

        if (!pack) { return false; }

        if (isArray(pack)) {
            list = pack;
        } else if (typeof pack === 'object') {
            if (pack.cooling === true || pack.thermal === true || pack.fan_control === true) {
                return true;
            }
            list = pack.installed;
        }

        if (!isArray(list)) { return false; }

        for (i = 0; i < list.length; i++) {
            if (list[i] === 'cooling' || list[i] === 'thermal' || list[i] === 'fan_control') {
                return true;
            }
        }
        return false;
    }

    /* Живое состояние термозащиты: считается по NVRAM, а не по памяти модуля. */
    function overheatState() {
        var oc      = (state.oc && typeof state.oc.voltage === 'number') ? state.oc : loadOC();
        var mem     = memoryState();
        var cooling = coolingDriversInstalled();
        var reasons = [];
        var over;

        if (oc.voltage > SAFE_OC.voltage) {
            reasons.push('CORE VOLTAGE ' + formatVoltage(oc.voltage) +
                ' > LIMIT ' + formatVoltage(SAFE_OC.voltage));
        }
        if (oc.multiplier > SAFE_OC.multiplier) {
            reasons.push('CPU RATIO ' + formatRatio(oc.multiplier) +
                ' > LIMIT ' + formatRatio(SAFE_OC.multiplier));
        }
        if (mem.unstable) { reasons = reasons.concat(mem.reasons); }

        over = reasons.length > 0;

        if (over && !cooling) { reasons.push('COOLING DRIVERS [NOT_INSTALLED]'); }

        return {
            active:     over && !cooling,
            over:       over,
            cooling:    cooling,
            voltage:    oc.voltage,
            multiplier: oc.multiplier,
            memory:     mem,
            severity:   Math.min(3, Math.max(1, reasons.length - (cooling ? 0 : 1))),
            text:       reasons.length ? reasons.join('  \u00b7  ') : 'Nominal'
        };
    }

    /* Журнал перегрева: его читают POST и ядро. armed = настройки сохранены. */
    function writeOverheatRecord(status, armed) {
        writeJSON(OVERHEAT_KEY, {
            armed:      armed === true,
            active:     status.active,
            voltage:    status.voltage,
            multiplier: status.multiplier,
            memory:     {
                xmp:          status.memory.xmp,
                freq_mhz:     status.memory.freq_mhz,
                dram_voltage: status.memory.voltage,
                cl:           status.memory.cl
            },
            cooling:    status.cooling,
            severity:   status.severity,
            reason:     status.text,
            updated:    new Date().toISOString()
        });
    }

    function readOverheatRecord() {
        var record = readJSON(OVERHEAT_KEY, null);
        return (record && typeof record === 'object') ? record : { active: false, armed: false };
    }

    function overheatArmed() {
        return readOverheatRecord().armed === true;
    }

    /* Save & Exit взводит артефакты: дальше машина стартует «нестабильной». */
    function armThermal() {
        writeOverheatRecord(overheatState(), true);
    }

    /* Заводские значения и выход без сохранения гасят артефакты. */
    function disarmThermal() {
        writeOverheatRecord(overheatState(), false);
    }

    /* --- 3d. Загрузочный диск: есть ли на VDFS что грузить ----------------- */
    /* Дистрибутивы пишет установщик (этап 16) в тот же ключ, что читает GRUB.
     * Пока ключ пуст, с винчестера грузиться нечего — это и есть отвал. */
    function normalizeDistro(record) {
        var name = '';

        if (typeof record === 'string') {
            name = record;
        } else if (record && typeof record === 'object') {
            if (typeof record.name === 'string')       { name = record.name;  }
            else if (typeof record.title === 'string') { name = record.title; }
            else if (typeof record.id === 'string')    { name = record.id;    }
        }
        return name.replace(/^\s+|\s+$/g, '');
    }

    function installedDistros() {
        var parsed = readJSON(DISTRO_KEY, null);
        var names  = [];
        var name, i;

        if (!isArray(parsed)) { return names; }

        for (i = 0; i < parsed.length; i++) {
            name = normalizeDistro(parsed[i]);
            if (name !== '') { names.push(name); }
        }
        return names;
    }

    /* Первым грузится верхняя строка Boot Priority (Boot Override — на раз).
     * POST зовёт проверку раньше init(), поэтому порядок берём прямо из NVRAM. */
    function firstBootDevice(override) {
        var order = (isArray(state.bootOrder) && state.bootOrder.length > 0)
            ? state.bootOrder
            : loadBootOrder();

        return override || order[0] || DEV_USB;
    }

    /* Secure Boot живёт в NVRAM: UI может быть ещё не собран (зовёт POST). */
    function secureBootEnabled() {
        var secure = readJSON(SECURE_KEY, null);

        if (secure && typeof secure.secure_boot === 'boolean') {
            return secure.secure_boot === true;
        }
        return !!(state.security && state.security.secure_boot === true);
    }

    /* Подпись сборки — тот же контракт, что у GRUB: signed === true или
     * непустой signature. Строка на диске подписью не считается. */
    function distroIsSigned(record) {
        var signature;

        if (!record || typeof record !== 'object') { return false; }
        if (record.signed === true) { return true; }

        signature = record.signature;
        return typeof signature === 'string' && signature.replace(/\s+/g, '') !== '';
    }

    /* Сколько сборок переживёт Secure Boot: считаем прямо по NVRAM. */
    function signedDistroCount() {
        var parsed = readJSON(DISTRO_KEY, null);
        var count  = 0;
        var i;

        if (!isArray(parsed)) { return 0; }

        for (i = 0; i < parsed.length; i++) {
            if (distroIsSigned(parsed[i])) { count++; }
        }
        return count;
    }

    /* Пустой винчестер первым в списке = грузиться нечему: GRUB не запускаем.
     * Secure Boot добавляет второй случай: сборки есть, но все не подписаны. */
    function bootFailureReason(override) {
        var total = installedDistros().length;

        if (firstBootDevice(override) !== DEV_VDFS) { return null; }

        if (total === 0) {
            return 'boot device #1 is ' + DEV_VDFS +
                ', but surgeon_installed_distros = [] (no operating system installed)';
        }

        if (secureBootEnabled() && signedDistroCount() === 0) {
            return 'boot device #1 is ' + DEV_VDFS + ', Secure Boot = [Enabled], but all ' +
                total + ' entr' + (total === 1 ? 'y is' : 'ies are') +
                ' unsigned (no signed build to load)';
        }

        return null;
    }

    /* Мост к VDFS: POST спрашивает чек-лист раньше init(), поэтому вне Setup
     * значение берём из NVRAM, а не из умолчаний модуля. */
    function vdfsBridgeEnabled() {
        if (!state.container) { loadPlatformSettings(); }
        return !!state.storage.vdfs_bridge;
    }

    /* --- 3e. Чек-лист Setup: без этих пунктов машина не поедет ------------- */
    /* POST спрашивает pending(): пока список не пуст, он показывает ошибку и
     * через 2 секунды возвращает пользователя сюда же. */
    var REQUIRED_SETUP = [
        {
            id:    'boot-order',
            label: 'Boot Option #1',
            row:   'REQUIRED: Flash Drive First',
            fix:   'SETTINGS -> Boot Priority: поднять ' + DEV_USB + ' в первый слот',
            value: function () { return firstBootDevice(null); },
            done:  function () { return firstBootDevice(null) === DEV_USB; }
        },
        {
            id:    'xmp',
            label: 'XMP Profile',
            row:   'REQUIRED: XMP Profile',
            fix:   'OC -> Memory Settings: включить Profile 1 / Profile 2 или Manual',
            value: function () { return memoryState().xmp; },
            done:  function () { return memoryState().xmp !== 'Disabled'; }
        },
        {
            id:    'vdfs-bridge',
            label: 'VDFS Bridge',
            row:   'REQUIRED: VDFS Bridge',
            fix:   'SETTINGS -> Storage: включить мост к виртуальному диску',
            value: function () { return boolLabel(vdfsBridgeEnabled()); },
            done:  function () { return vdfsBridgeEnabled(); }
        }
    ];

    /* Пункты, которые ещё не выставлены: их список уходит в POST. */
    function pendingSetupItems() {
        var out = [];
        var i, item;

        for (i = 0; i < REQUIRED_SETUP.length; i++) {
            item = REQUIRED_SETUP[i];
            if (item.done()) { continue; }

            out.push({
                id:    item.id,
                label: item.label,
                value: item.value(),
                fix:   item.fix
            });
        }
        return out;
    }

    function setupChecklistDone() {
        return pendingSetupItems().length === 0;
    }

    /* Живые строки чек-листа: выполнено — [значение] DONE, нет — [PENDING]. */
    function paintSetupChecklist() {
        var pending = pendingSetupItems();
        var total   = REQUIRED_SETUP.length;
        var i, item, node;

        for (i = 0; i < REQUIRED_SETUP.length; i++) {
            item = REQUIRED_SETUP[i];
            node = state.checkRowEls[item.id];
            if (!node) { continue; }

            node.textContent = item.done() ? '[' + item.value() + '] DONE' : '[PENDING]';
            node.className   = item.done() ? 'bios-row-value is-ok' : 'bios-row-value is-danger';
        }

        if (state.statusCheckEl) {
            state.statusCheckEl.textContent = '[' + (total - pending.length) + '/' + total + ']';
            state.statusCheckEl.className   = pending.length
                ? 'status-value is-danger' : 'status-value';
        }

        if (state.setupBannerEl) {
            state.setupBannerEl.textContent = pending.length
                ? 'SETUP REQUIRED: не выставлено ' + pending.length + ' из ' + total +
                  ' обязательных пунктов — POST не пустит машину дальше'
                : '';
            state.setupBannerEl.className = pending.length
                ? 'setup-banner is-visible' : 'setup-banner';
        }
    }

    /* --- 3f. Чек-лист в интерфейсе ---------------------------------------- */
    /* Панель на вкладке SETTINGS: видно, что POST ещё не пропустит. */
    function buildChecklistGroup() {
        var box = groupBox('Setup Checklist (REQUIRED)');
        var i, item, value;

        state.checkRowEls = {};

        for (i = 0; i < REQUIRED_SETUP.length; i++) {
            item  = REQUIRED_SETUP[i];
            value = el('span', 'bios-row-value', item.done() ? 'DONE' : '[PENDING]');

            box.appendChild(biosRowNode(item.row, value));
            box.appendChild(biosNote('  ' + item.fix));

            state.checkRowEls[item.id] = value;
        }

        box.appendChild(biosNote('POST проверяет список после Save & Exit: пока он не пуст, ' +
            'машина вернётся сюда через 2 секунды.'));

        paintSetupChecklist();
        return box;
    }

    /* --- 3g. Движок артефактов: слабые помехи и цветные полосы ------------- */
    /* Один движок на всю страницу: им пользуются и Click BIOS, и POST. */
    var thermal = {
        active:   false,
        rootEl:   null,
        timerId:  null,
        severity: 1,      // 1..3: сильнее перегрев — заметнее помехи
        shuffled: [],     // узлы, которым сдвинули transform: их и откатываем
        barBox:   null,   // контейнер цветных полос
        posSaved: false   // корню сами выставили position, если он был static
    };

    function randomInt(min, max) {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    function randomRange(min, max) {
        return min + Math.random() * (max - min);
    }

    function randomFrom(list) {
        return list[randomInt(0, list.length - 1)];
    }

    /* Тяжесть перегрева: 1 — чуть дрожит, 3 — экран заметно колбасит. */
    function severityScale() {
        return 0.7 + (thermal.severity - 1) * 0.35;
    }

    function rollbackShuffled() {
        var node, i;

        for (i = 0; i < thermal.shuffled.length; i++) {
            node = thermal.shuffled[i];
            node.style.transform  = '';
            node.style.visibility = '';
        }
        thermal.shuffled = [];

        if (thermal.barBox && thermal.barBox.parentNode) {
            thermal.barBox.parentNode.removeChild(thermal.barBox);
        }
        thermal.barBox = null;
    }

    /* Общий фильтр экрана: раз в восемь тиков гаснет целиком — это мерцание. */
    function paintOverheatFilter(root) {
        var scale = severityScale();

        if (randomInt(0, 7) === 0) {
            root.style.filter     = 'none';
            root.style.textShadow = 'none';
            return;
        }

        root.style.filter =
            'blur(' + (randomRange(0.15, 0.7) * scale).toFixed(2) + 'px)' +
            ' contrast(' + (1 + randomRange(0.04, 0.22) * scale).toFixed(2) + ')' +
            ' saturate(' + (1 - randomRange(0.02, 0.16) * scale).toFixed(2) + ')' +
            ' skew(' + randomRange(-0.5, 0.5).toFixed(2) + 'deg)';
    }

    /* Разноцветные полосы в случайных местах экрана — главный признак сбоя. */
    function paintGlitchBars(root) {
        var box   = el('div', 'glitch-bars');
        var scale = severityScale();
        var count = randomInt(GLITCH_BARS.min, GLITCH_BARS.max);
        var bar, i;

        for (i = 0; i < count; i++) {
            bar = el('div', 'glitch-bar');
            bar.style.top        = randomRange(2, 96).toFixed(1) + '%';
            bar.style.left       = randomRange(0, 45).toFixed(1) + '%';
            bar.style.width      = randomRange(12, 55).toFixed(1) + '%';
            bar.style.height     = randomInt(1, Math.max(2, Math.round(4 * scale))) + 'px';
            bar.style.background = randomFrom(GLITCH_COLORS);
            bar.style.opacity    = (randomRange(0.12, 0.4) * scale).toFixed(2);
            bar.style.transform  = 'skewX(' + randomRange(-12, 12).toFixed(1) + 'deg)';
            box.appendChild(bar);
        }

        root.appendChild(box);
        thermal.barBox = box;
    }

    function glitchTick() {
        var root  = thermal.rootEl;
        var nodes, node, i;

        if (!thermal.active || !root || !root.parentNode) { return; }

        rollbackShuffled();
        paintOverheatFilter(root);

        nodes = root.querySelectorAll(GLITCH_SELECTOR);
        for (i = 0; i < nodes.length; i++) {
            if (Math.random() > GLITCH_RATIO) { continue; }   // две трети узлов спокойны

            node = nodes[i];
            node.style.transform = 'translate(' + randomRange(-3, 3).toFixed(1) + 'px, ' +
                randomRange(-2, 2).toFixed(1) + 'px) skewX(' +
                randomRange(-2.5, 2.5).toFixed(1) + 'deg)';

            if (randomInt(0, 24) === 0) { node.style.visibility = 'hidden'; }

            thermal.shuffled.push(node);
        }

        paintGlitchBars(root);
    }

    /* rootEl — корень слоя (Setup, экран POST, экран ошибки): его и трясёт.
     * severity берётся из overheatState(): 1..3. */
    function startThermalArtifacts(rootEl, severity) {
        if (!rootEl) { return; }

        stopThermalArtifacts();
        thermal.active   = true;
        thermal.rootEl   = rootEl;
        thermal.severity = Math.min(3, Math.max(1, Math.round(severity) || 1));

        /* Полосам нужен позиционированный родитель. */
        if (window.getComputedStyle(rootEl).position === 'static') {
            rootEl.style.position = 'relative';
            thermal.posSaved = true;
        }

        rootEl.classList.add('surgeon-overheat');

        glitchTick();
        thermal.timerId = window.setInterval(glitchTick, GLITCH_TICK_MS);
    }

    function stopThermalArtifacts() {
        var root = thermal.rootEl;

        if (thermal.timerId !== null) {
            window.clearInterval(thermal.timerId);
            thermal.timerId = null;
        }
        rollbackShuffled();

        if (root) {
            root.style.filter     = '';
            root.style.textShadow = '';
            if (thermal.posSaved) { root.style.position = ''; }
            root.classList.remove('surgeon-overheat');
        }

        thermal.active   = false;
        thermal.rootEl   = null;
        thermal.severity = 1;
        thermal.posSaved = false;
    }

    /* --- 3e. Экран "No Bootable Device" ----------------------------------- */
    /* Setup гаснет, GRUB не грузится. Выхода два: F5 — перезагрузка,
     * <Del> x DEL_PRESSES — назад в Setup, где лежит Boot Priority. Второй
     * выход обязателен: без него экран был тупиком, и починить порядок
     * загрузки из него было нельзя. */
    var nobootTimer      = null;
    var nobootHandler    = null;
    var nobootPresses    = 0;
    var nobootProgressEl = null;

    /* Строки чёрного экрана: порядок загрузки — настоящий, из NVRAM. */
    function noBootLines() {
        var order = (isArray(state.bootOrder) && state.bootOrder.length > 0)
            ? state.bootOrder
            : loadBootOrder();

        return [
            'SURGEON CLICK BIOS 5  \u00b7  POST  \u00b7  ' + PA_VERSION,
            '',
            'Boot Option #1 : ' + (order[0] || DEV_USB),
            'Boot Option #2 : ' + (order[1] || DEV_VDFS),
            '',
            'An operating system wasn\'t found. Try disconnecting any drives that',
            'don\'t contain an operating system.',
            'Fix : <Del> x' + DEL_PRESSES + ' -> SETTINGS -> Boot Priority:',
            '      ' + DEV_USB + ' must stay in slot #1.',
            'Reboot via F5...',
            '',
            'No Bootable Device Found. Insert Boot Media and Press Any Key'
        ];
    }

    function hideLayer(id) {
        var node = document.getElementById(id);

        if (!node) { return; }
        node.innerHTML = '';
        node.style.display = 'none';
    }

    /* Намертво гасит машину: чёрный экран, мигающий курсор. Выходы — F5
     * (перезагрузка) и <Del> x DEL_PRESSES (назад в Setup). */
    function showNoBootableDevice(reason) {
        var layer, log, detail, lines, i;

        stopThermalArtifacts();
        removeThermalBanner();
        destroy();                       // Setup гаснет целиком

        /* Остальные слои машины тоже гасим: грузиться нечему. */
        hideLayer('surgeon-grub');
        hideLayer('surgeon-terminal');
        hideLayer('surgeon-desktop');
        hideLayer('surgeon-post');
        hideLayer(CONTAINER_ID);

        if (document.getElementById(NOBOOT_ID)) { return; }

        layer    = el('div', 'noboot-screen');
        layer.id = NOBOOT_ID;
        log      = el('div', 'noboot-log');

        lines = noBootLines();
        for (i = 0; i < lines.length; i++) {
            log.appendChild(el('div', 'noboot-line', lines[i]));
        }

        detail = el('div', 'noboot-line noboot-detail', reason);
        detail.appendChild(el('span', 'noboot-cursor', '\u2588'));
        log.appendChild(detail);

        /* Строку прогресса <Del> переписывает обработчик клавиш. */
        nobootProgressEl = el('div', 'noboot-line', '');
        log.appendChild(nobootProgressEl);

        layer.appendChild(log);
        document.body.appendChild(layer);

        /* Курсор мигает: анимаций в проекте нет, значит интервал. */
        nobootTimer = window.setInterval(function () {
            var cursor = layer.querySelector('.noboot-cursor');

            if (!cursor) { return; }
            cursor.style.visibility = (cursor.style.visibility === 'hidden') ? 'visible' : 'hidden';
        }, 500);

        /* Клавиши гасим все: F5 — перезагрузка, <Del> x5 — назад в Setup. */
        nobootPresses = 0;
        nobootHandler = function (event) {
            var code = event.keyCode || event.which;
            var key  = event.key || '';

            event.preventDefault();

            if (code === KEY_F5 || key === 'F5') {
                leaveNoBootableDevice();
                window.location.reload();
                return;
            }

            if (code === KEY_DELETE || key === 'Delete') {
                nobootPresses++;
                console.log('[CLICK BIOS] Setup request from no-boot screen: <Del> x' +
                    nobootPresses + ' / ' + DEL_PRESSES);

                if (nobootPresses >= DEL_PRESSES) {
                    leaveNoBootableDevice();
                    console.warn('[CLICK BIOS] Back to Setup from no-boot screen: ' +
                        'Boot Option #1 must be ' + DEV_USB + '.');
                    init();                  // чинить порядок загрузки можно только там
                    return;
                }

                if (nobootProgressEl) {
                    nobootProgressEl.textContent = 'Setup Request : ' + nobootPresses + '/' +
                        DEL_PRESSES + ' \u2014 press <Del> ' + (DEL_PRESSES - nobootPresses) +
                        ' more time(s)';
                }
            }
        };
        window.addEventListener('keydown', nobootHandler, true);

        console.error('[CLICK BIOS] No bootable device: ' + reason);
    }

    /* Снимает чёрный экран целиком: таймер, обработчик и сам слой. */
    function leaveNoBootableDevice() {
        var node = document.getElementById(NOBOOT_ID);

        if (nobootTimer !== null) {
            window.clearInterval(nobootTimer);
            nobootTimer = null;
        }
        if (nobootHandler) {
            window.removeEventListener('keydown', nobootHandler, true);
            nobootHandler = null;
        }
        if (node && node.parentNode) {
            node.parentNode.removeChild(node);
        }

        nobootPresses    = 0;
        nobootProgressEl = null;
        return true;
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

    function indexOfValue(list, value) {
        var i;

        for (i = 0; i < list.length; i++) {
            if (list[i] === value) { return i; }
        }
        return -1;
    }

    /* Строка-переключатель: клик гонит значения по кругу и сразу пишет NVRAM.
     * Текст кнопки меняется мгновенно, перерисовка вкладки не нужна. */
    function toggleRow(label, values, current, onPick) {
        var index  = indexOfValue(values, current);
        var row    = el('div', 'bios-row');
        var toggle;

        if (index < 0) { index = 0; }

        toggle = button('bios-toggle', '[' + values[index] + ']');
        toggle.addEventListener('click', function () {
            index = (index + 1) % values.length;
            toggle.textContent = '[' + values[index] + ']';
            onPick(values[index]);
        });

        row.appendChild(el('span', 'bios-row-label', label));
        row.appendChild(toggle);
        return { row: row, toggle: toggle, value: function () { return values[index]; } };
    }

    /* Строка-действие: подпись слева, кнопка справа (сброс, override и т.п.). */
    function actionRow(label, caption, onPick) {
        var row  = el('div', 'bios-row');
        var node = button('bios-toggle', caption);

        node.addEventListener('click', onPick);
        row.appendChild(el('span', 'bios-row-label', label));
        row.appendChild(node);
        return { row: row, button: node };
    }

    /* Реестр знает про разгон: ядру важно, штатный ли режим у машины. */
    function syncOverclockFlag() {
        var reg     = registry();
        var cpuFlag = (state.oc.multiplier !== DEFAULT_OC.multiplier) ||
                      (state.oc.voltage !== DEFAULT_OC.voltage);
        var memFlag = memoryOverclocked();
        var mem     = memoryState();
        var text;

        reg.hardware.cpu.overclocked = cpuFlag;
        reg.system_flags.memory_overclocked = memFlag;

        text = '[' + (cpuFlag ? 'Yes' : 'No') + ']';

        if (state.ocFlagEl)   { state.ocFlagEl.textContent   = text; }
        if (state.ocStatusEl) { state.ocStatusEl.textContent = cpuFlag ? 'Enabled' : 'Disabled'; }

        if (state.memStatusEl) {
            state.memStatusEl.textContent = mem.unstable ? 'UNSTABLE' : (memFlag ? 'Overclocked' : 'Nominal');
            state.memStatusEl.className   = mem.unstable ? 'status-value is-danger' : 'status-value';
        }
    }

    /* --- 5a. Флаги платформы: NVRAM + реестр + правая панель -------------- */
    /* SATA Mode: IDE оставляет ядру io_throttle 0.7 — минус 30% к I/O и логам. */
    function setSataMode(mode) {
        var legacy = (mode === 'IDE');
        var reg    = registry();

        state.storage.sata_mode = legacy ? 'IDE' : 'AHCI';
        writeJSON(SATA_KEY, state.storage);

        reg.system_flags.sata_mode   = state.storage.sata_mode;
        reg.system_flags.io_throttle = legacy ? 0.7 : 1;

        paintStatusFlags();
        showNotice(legacy
            ? 'SATA Mode [IDE]: режим совместимости, I/O и логи ядра медленнее на 30% ' +
              '(io_throttle = 0.7). POST и GRUB тикают на треть медленнее.'
            : 'SATA Mode [AHCI]: полная скорость накопителя.');
    }

    function setVdfsBridge(enabled) {
        state.storage.vdfs_bridge = !!enabled;
        writeJSON(SATA_KEY, state.storage);
        registry().system_flags.vdfs_bridge = !!enabled;

        paintStatusFlags();       // мост — обязательный пункт чек-листа
        showNotice('VDFS Bridge [' + boolLabel(!!enabled) +
            ']: мост к виртуальному накопителю /Versions/Apps/.');
    }

    /* Legacy USB: Disabled — в меню GRUB клавиатуры нет, ждём таймер 5 сек. */
    function setLegacyUsb(enabled) {
        state.usb.legacy_usb = !!enabled;
        writeJSON(USB_KEY, state.usb);
        registry().system_flags.legacy_usb = !!enabled;

        paintStatusFlags();
        showNotice(enabled
            ? 'Legacy USB Support [Enabled]: клавиатура работает и в меню GRUB.'
            : 'Legacy USB Support [Disabled]: клавиатура в GRUB отключена, ' +
              'загрузка пойдёт по таймеру 5 сек.');
    }

    /* Secure Boot: Enabled — песочница пустит только подписанную сборку. */
    function setSecureBoot(enabled) {
        var distros = installedDistros();

        state.security.secure_boot = !!enabled;
        writeJSON(SECURE_KEY, state.security);
        registry().system_flags.secure_boot = !!enabled;

        paintStatusFlags();
        showNotice(!enabled
            ? 'Secure Boot [Disabled]: подпись дистрибутивов не проверяется.'
            : 'Secure Boot [Enabled]: незаверенные сборки не стартуют ' +
              '(установлено дистрибутивов: ' + distros.length + ').');
    }

    /* Реестр железа: POST и ядро читают флаги платформы отсюда. */
    function applyRegistryFlags() {
        var reg     = registry();
        var thermal = overheatState();

        reg.system_flags.sata_mode     = state.storage.sata_mode;
        reg.system_flags.io_throttle   = (state.storage.sata_mode === 'IDE') ? 0.7 : 1;
        reg.system_flags.legacy_usb    = !!state.usb.legacy_usb;
        reg.system_flags.secure_boot   = !!state.security.secure_boot;
        reg.system_flags.vdfs_bridge   = !!state.storage.vdfs_bridge;
        reg.system_flags.boot_device   = state.bootOrder[0] || DEV_USB;
        reg.system_flags.thermal_state = thermal.active ? 'OVERHEAT' : 'NOMINAL';
        reg.system_flags.memory_xmp    = thermal.memory.xmp;
        reg.system_flags.memory_mhz    = thermal.memory.freq_mhz;
        reg.system_flags.overheat_armed = overheatArmed();
    }

    /* Правая панель: живые значения флагов. */
    function paintStatusFlags() {
        var status = overheatState();

        if (state.statusBootEl)   { state.statusBootEl.textContent   = '[' + (state.bootOrder[0] || DEV_USB) + ']'; }
        if (state.statusSataEl)   { state.statusSataEl.textContent   = '[' + state.storage.sata_mode + ']'; }
        if (state.statusUsbEl)    { state.statusUsbEl.textContent    = '[' + boolLabel(!!state.usb.legacy_usb) + ']'; }
        if (state.statusSecureEl) { state.statusSecureEl.textContent = '[' + boolLabel(!!state.security.secure_boot) + ']'; }

        if (state.statusThermalEl) {
            state.statusThermalEl.textContent = '[' + (status.active ? 'ACTIVE' : 'Nominal') + ']';
            state.statusThermalEl.className   = status.active ? 'status-value is-danger' : 'status-value';
        }

        paintSetupChecklist();      // чек-лист живёт на тех же флагах
    }

    /* Подтверждение последнего клика. Пустая строка — сообщение убирается. */
    function showNotice(text) {
        if (!state.noticeEl) { return; }

        state.noticeEl.textContent = text || '';
        state.noticeEl.className   = text ? 'uefi-notice is-visible' : 'uefi-notice';
    }

    /* --- 5b. Перегрев в интерфейсе ---------------------------------------- */
    function paintThermalReadout(status) {
        if (state.thermalEl) {
            state.thermalEl.textContent = '[' + (status.active ? 'ACTIVE' : 'Nominal') + ']';
            state.thermalEl.className   = status.active
                ? 'bios-row-value is-danger' : 'bios-row-value';
        }
        if (state.thermalCauseEl) { state.thermalCauseEl.textContent = status.text; }

        if (state.memUnstableEl) {
            state.memUnstableEl.textContent = '[' + (status.memory.unstable ? 'UNSTABLE' : 'Stable') + ']';
            state.memUnstableEl.className   = status.memory.unstable
                ? 'bios-row-value is-danger' : 'bios-row-value';
        }

        paintStatusFlags();
    }

    /* Полоса аварийного режима висит внизу экрана и переживает смену вкладок.
     * В самом Setup экран чистый: искажения включаются только после Save & Exit. */
    function buildThermalBanner(status) {
        var bar, reset, detail;

        if (!state.container) { return; }

        if (!state.bannerEl) {
            bar    = el('div', 'thermal-banner');
            reset  = button('thermal-banner-reset', 'RESET BIOS (Ctrl+Alt+R)');
            detail = el('span', 'thermal-banner-detail', '');

            reset.addEventListener('click', function () { emergencyReset(); });

            bar.appendChild(el('span', 'thermal-banner-title', 'EMERGENCY THERMAL OVERRIDE'));
            bar.appendChild(reset);
            bar.appendChild(detail);
            state.container.appendChild(bar);
            state.bannerEl = bar;
        }

        detail = state.bannerEl.lastChild;
        if (detail) {
            detail.textContent = status.text +
                '  \u00b7  GLITCH SEVERITY ' + status.severity + '/3  \u00b7  CLOCK THROTTLED 70%' +
                (overheatArmed() ? '  \u00b7  ARMED (появится после перезагрузки)'
                    : '  \u00b7  сохраните настройки (F10), чтобы увидеть последствия');
        }
    }

    function removeThermalBanner() {
        if (state.bannerEl && state.bannerEl.parentNode) {
            state.bannerEl.parentNode.removeChild(state.bannerEl);
        }
        state.bannerEl = null;
    }

    /* Считает термозащиту по NVRAM и красит интерфейс.
     * Артефакты здесь НЕ включаются: они ждут Save & Exit и перезагрузки. */
    function evaluateThermal() {
        var status = overheatState();
        var armed  = overheatArmed();

        /* Журнал держит флаг armed как есть: его меняют только Save & Exit,
         * Ctrl+Alt+R и выход без сохранения. */
        writeOverheatRecord(status, armed);
        applyRegistryFlags();
        paintThermalReadout(status);

        if (status.active) {
            buildThermalBanner(status);

            if (!armed) {
                console.warn('[CLICK BIOS] Thermal override pending (not armed yet): ' + status.text);
            }
            return;
        }

        removeThermalBanner();
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
            PA_VERSION + '  ·  Rev. ' + BIOS_REV + '  ·  ' + BIOS_BUILD));

        state.voltEl    = el('span', 'uefi-metric-value', formatVoltage(state.oc.voltage));
        state.ratioEl   = el('span', 'uefi-metric-value', formatRatio(state.oc.multiplier));
        state.memMetricEl = el('span', 'uefi-metric-value', memoryMetricText());

        center.appendChild(metric('CPU TEMPERATURE',
            el('span', 'uefi-metric-value', formatTemp(CPU_TEMP))));
        center.appendChild(metric('CPU VOLTAGE', state.voltEl));
        center.appendChild(metric('CPU RATIO', state.ratioEl));
        center.appendChild(metric('MEMORY', state.memMetricEl));

        state.clockEl = el('span', 'uefi-clock', '--:--:--');
        right.appendChild(state.clockEl);

        /* Save & Exit = перезагрузка: сначала POST, потом всё остальное. */
        var saveExit = button('uefi-save-exit', 'SAVE & EXIT (F10)');
        saveExit.addEventListener('click', function () { saveAndExit(); });
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
        legend.appendChild(el('div', 'uefi-legend-keys',
            'Ctrl+Alt+R:Drop OC Profile   F5:Reboot   <Del> x' + DEL_PRESSES +
            ':Setup (после "No Bootable Device")'));
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

        /* Подтверждения живут вне блока справки: смена вкладки их не стирает. */
        state.noticeEl = el('div', 'uefi-notice', '');
        side.appendChild(state.noticeEl);

        var body = el('div', 'uefi-body');
        body.appendChild(state.contentEl);
        body.appendChild(side);

        shell.appendChild(buildHeader());
        shell.appendChild(buildMenubar());

        /* Полоса «SETUP REQUIRED»: видна, пока чек-лист не закрыт. */
        state.setupBannerEl = el('div', 'setup-banner', '');
        shell.appendChild(state.setupBannerEl);

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
        state.memStatusEl = el('span', 'status-value', 'Nominal');
        state.statusCheckEl = el('span', 'status-value', '[0/3]');

        /* Живые значения флагов: их переписывают сеттеры при каждом клике. */
        state.statusSataEl    = el('span', 'status-value', '[' + state.storage.sata_mode + ']');
        state.statusUsbEl     = el('span', 'status-value', '[' + boolLabel(!!state.usb.legacy_usb) + ']');
        state.statusSecureEl  = el('span', 'status-value', '[' + boolLabel(!!state.security.secure_boot) + ']');
        state.statusThermalEl = el('span', 'status-value', '[Nominal]');

        /* Boot Option #1 — тоже живая строка: клик в Boot Priority её двигает. */
        state.statusBootEl = el('span', 'status-value', '[' + (state.bootOrder[0] || DEV_USB) + ']');

        box.appendChild(statusRow('BIOS Version', BIOS_VER));
        box.appendChild(statusRow('BIOS Build', BIOS_BUILD));
        box.appendChild(statusRow('BIOS Rev', BIOS_REV));
        box.appendChild(statusRow('Board', BOARD_NAME + ' (VDFS)'));
        box.appendChild(statusRow('Processor', CPU_MODEL));
        box.appendChild(statusRow('CPU Status', reg.hardware.cpu.status));
        box.appendChild(statusRow('Microcode', reg.hardware.cpu.microcode));
        box.appendChild(statusRowNode('Overclocking', state.ocStatusEl));
        box.appendChild(statusRowNode('Memory Status', state.memStatusEl));
        box.appendChild(statusRow('Total Memory', memoryMetricText() + ' (DDR4)'));
        box.appendChild(statusRow('Storage', diskStatusText(disk)));
        box.appendChild(statusRow('pww13 Mount', '[/core/ /drivers/]'));
        box.appendChild(statusRow('vdfs Mount', '[/home/ /Versions/Apps/]'));
        box.appendChild(statusRow('Disk Ready', diskReadyText()));
        box.appendChild(statusRow('Boot Mode', 'UEFI / VDFS'));
        box.appendChild(statusRowNode('Setup Checklist', state.statusCheckEl));
        box.appendChild(statusRowNode('Boot Option #1', state.statusBootEl));
        box.appendChild(statusRowNode('SATA Mode', state.statusSataEl));
        box.appendChild(statusRowNode('Legacy USB', state.statusUsbEl));
        box.appendChild(statusRowNode('Secure Boot', state.statusSecureEl));
        box.appendChild(statusRowNode('Thermal Override', state.statusThermalEl));
        box.appendChild(statusRow('Cooling Drivers',
            '[' + (coolingDriversInstalled() ? 'installed' : 'NOT_INSTALLED') + ']'));
        box.appendChild(statusRow('Installed Distros', '[' + installedDistros().length + ']'));
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

        paintSetupChecklist();      // полоса и панель живут на всех вкладках
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
        var boot, storage, usb, secure, recovery, diskBox, diskState, reg, part, i;

        content.appendChild(el('h2', 'uefi-title', 'SETTINGS'));

        /* Первым делом — обязательные пункты: их проверяет POST. */
        content.appendChild(buildChecklistGroup());

        boot = groupBox('Boot Configuration');
        for (i = 0; i < state.bootOrder.length; i++) {
            boot.appendChild(buildBootItem(i));
        }
        boot.appendChild(biosNote(
            'Клик по имени устройства меняет его, стрелки ↑ / ↓ двигают приоритет. ' +
            'Значение пишется в NVRAM сразу, отдельного "сохранения" нет.'));
        content.appendChild(boot);

        /* Отвал загрузки: предупреждаем там, где его и создают. */
        if (bootFailureReason(null)) {
            content.appendChild(el('div', 'bios-alert',
                'WARNING: Boot Option #1 = ' + DEV_VDFS + ', но surgeon_installed_distros = []. ' +
                'Save & Exit (F10) приведёт к "No Bootable Device": GRUB не загрузится.'));
        }

        storage = groupBox('Storage Configuration');
        storage.appendChild(toggleRow('SATA Mode Selection', ['AHCI', 'IDE'],
            state.storage.sata_mode, setSataMode).row);
        storage.appendChild(biosRow('SATA Port 0', '[SURGEON_VDFS_SSD 512GB]'));
        storage.appendChild(biosRow('SATA Port 1', '[SURGEON_OPTICAL_DVD-RW]'));
        storage.appendChild(toggleRow('VDFS Bridge', ['Enabled', 'Disabled'],
            boolLabel(!!state.storage.vdfs_bridge),
            function (value) { setVdfsBridge(value === 'Enabled'); }).row);
        storage.appendChild(biosNote(
            'SATA Mode [IDE]: контроллер уходит в режим совместимости, I/O и логи ядра ' +
            'медленнее на 30% (io_throttle = 0.7).'));
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
        usb.appendChild(toggleRow('Legacy USB Support', ['Enabled', 'Disabled'],
            boolLabel(!!state.usb.legacy_usb),
            function (value) { setLegacyUsb(value === 'Enabled'); }).row);
        usb.appendChild(biosRow('XHCI Hand-off', '[Enabled]'));
        usb.appendChild(biosRow('USB Mass Storage Driver', '[Enabled]'));
        usb.appendChild(biosRow('USB Devices Found', '1 Keyboard, 1 Mouse'));
        usb.appendChild(biosNote(
            'Legacy USB Support [Disabled]: в меню GRUB клавиатура мертва — ' +
            'машина пойдёт дальше сама по таймеру 5 сек.'));
        content.appendChild(usb);

        secure = groupBox('Secure Boot');
        secure.appendChild(toggleRow('Secure Boot', ['Disabled', 'Enabled'],
            boolLabel(!!state.security.secure_boot),
            function (value) { setSecureBoot(value === 'Enabled'); }).row);
        secure.appendChild(biosRow('Platform Key (PK)', '[Not Installed]'));
        secure.appendChild(biosRow('Boot Mode', '[UEFI / VDFS]'));
        secure.appendChild(biosRow('Installed Distros',
            '[' + installedDistros().length + ' in NVRAM]'));
        secure.appendChild(biosRow('Unsigned Distros',
            '[' + (state.security.secure_boot ? 'BLOCKED' : 'allowed') + ']'));
        secure.appendChild(biosRow('Fast Boot', '[Disabled]'));
        secure.appendChild(biosNote(
            'Secure Boot [Enabled]: GRUB спрячет все сборки без подписи — ' +
            'в песочницу пустят только сертифицированное ядро Surgeon.'));
        content.appendChild(secure);

        /* Аварийный выход: гасит перегрев и разгон за лимитами, НЕ снося
         * настройки чек-листа. Полный сброс NVRAM — отдельной строкой. */
        recovery = groupBox('Reset / Recovery');
        recovery.appendChild(actionRow('Clear Overclock (Ctrl+Alt+R)',
            'DROP OC PROFILE', function () { emergencyReset(); }).row);
        recovery.appendChild(actionRow('Clear Thermal Override',
            'COOL DOWN', function () {
                clearThermalOverride();
                removeThermalBanner();
                switchTab('settings');
                showNotice('Артефакты сняты: разгон за лимитами сброшен, ' +
                    'XMP и порядок загрузки на месте.');
            }).row);
        recovery.appendChild(actionRow('Restore Defaults (NVRAM reset)',
            'LOAD UEFI DEFAULTS', function () {
                restoreDefaults();
                switchTab('settings');
                showNotice('Заводские значения: XMP снова Disabled — его надо ' +
                    'выставить заново на вкладке OC.');
            }).row);
        recovery.appendChild(biosNote(
            'Заводские значения: флешка первой, SATA [AHCI], Legacy USB [Enabled], ' +
            'Secure Boot [Disabled], память DDR4-3200 CL16, 1.032V / 36x. ' +
            'XMP после полного сброса выключен: POST попросит выставить его заново.'));
        content.appendChild(recovery);
    }

    /* Пункт порядка загрузки: слот, имя устройства, стрелки ↑ и ↓. */
    function buildBootItem(index) {
        var item   = el('div', 'boot-item');
        var arrows = [];
        var name, up, down, i;

        item.appendChild(el('span', 'boot-slot', 'Boot Option #' + (index + 1)));

        /* Клик по имени меняет устройство: список тот же, что у Boot Override. */
        name = button('boot-name', state.bootOrder[index]);
        name.title = 'Клик меняет устройство слота: Live-USB <-> VDFS';
        name.addEventListener('click', function () { cycleBootDevice(index); });
        item.appendChild(name);

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
        paintStatusFlags();          // стрелки ↑ / ↓ тоже двигают слот #1
        switchTab('settings');      // список перерисовывается целиком, одним кадром
    }

    /* Устройство в слоте: клик берёт следующее из списка и меняет его местами
     * с тем слотом, где оно уже стоит, — дублей в Boot Priority не бывает. */
    function cycleBootDevice(index) {
        var order  = state.bootOrder;
        var slot   = indexOfValue(BOOT_DEVICES, order[index]);
        var next, target, swap;

        if (slot < 0) { slot = 0; }

        next   = BOOT_DEVICES[(slot + 1) % BOOT_DEVICES.length];
        target = indexOfValue(order, next);

        if (target === -1) {
            order[index] = next;
        } else if (target !== index) {
            swap          = order[index];
            order[index]  = order[target];
            order[target] = swap;
        }

        writeJSON(BOOT_ORDER_KEY, order);
        paintStatusFlags();          // панель справа показывает новый слот #1
        switchTab('settings');
    }

    /* --- 10. Вкладка OC ---------------------------------------------------- */
    function renderOC() {
        var content = state.contentEl;
        var mem     = memoryState();
        var ratio, volt, memory, extra, thermalBox, status;

        content.appendChild(el('h2', 'uefi-title', 'OC (OVERCLOCKING)'));

        ratio = groupBox('CPU Ratio Settings');
        ratio.appendChild(sliderRow('CPU Ratio', 'multiplier'));
        ratio.appendChild(biosNote('Множитель реально гонит машину: POST и таймер GRUB идут ' +
            'быстрее. За ' + formatRatio(SAFE_OC.multiplier) + ' нужны драйверы охлаждения.'));
        content.appendChild(ratio);

        volt = groupBox('CPU Core Voltage');
        volt.appendChild(sliderRow('CPU Core Voltage', 'voltage'));
        content.appendChild(volt);

        /* Память: профиль XMP из паспорта модулей или всё руками. */
        memory = groupBox('Memory Settings (DRAM)');
        memory.appendChild(toggleRow('XMP Profile', XMP_VALUES, mem.xmp, applyXmp).row);
        memory.appendChild(sliderRow('DRAM Frequency', 'freq_mhz', 'mem'));
        memory.appendChild(sliderRow('DRAM Voltage', 'dram_voltage', 'mem'));
        memory.appendChild(sliderRow('CAS Latency (tCL)', 'cl', 'mem'));
        memory.appendChild(biosRow('Memory Clock',
            '[' + mem.clock + ' MHz (DDR4-' + mem.freq_mhz + ')]'));

        state.memUnstableEl = el('span', 'bios-row-value', mem.unstable ? '[UNSTABLE]' : '[Stable]');
        memory.appendChild(biosRowNode('Memory Status', state.memUnstableEl));
        memory.appendChild(biosNote('Паспортные лимиты: DDR4-' + SAFE_MEM.freq_mhz + ' / ' +
            formatVoltage(SAFE_MEM.dram_voltage) + ' / CL' + SAFE_MEM.cl +
            '. Выше — машина стартует нестабильной.'));
        content.appendChild(memory);

        extra = groupBox('Frequency / Voltage Control');
        state.ocFlagEl = el('span', 'bios-row-value', '[No]');
        extra.appendChild(biosRow('CPU Status', '[' + registry().hardware.cpu.status + ']'));
        extra.appendChild(biosRowNode('Overclocked', state.ocFlagEl));
        extra.appendChild(biosRow('CPU Base Clock', '[100.00 MHz]'));
        extra.appendChild(biosRow('Turbo Mode', '[Enabled]'));
        extra.appendChild(biosRow('Load-Line Calibration', '[Auto]'));
        extra.appendChild(biosRow('XMP Profile (NVRAM)', '[' + mem.xmp + ']'));
        extra.appendChild(biosRow('Speed Boost', '[' + speedBoostText() + ']'));
        extra.appendChild(biosRow('OC Profile (NVRAM)', '[surgeon_bios_oc / surgeon_bios_memory]'));
        extra.appendChild(biosNote(
            'Разгон — на свой риск: датчики врут, потому что железо виртуальное.'));
        content.appendChild(extra);

        /* Термозащита: за лимитами машина стартует нестабильной. */
        status     = overheatState();
        thermalBox = groupBox('Thermal Protection');

        state.thermalEl      = el('span', 'bios-row-value', '[Nominal]');
        state.thermalCauseEl = el('div', 'bios-row-note', status.text);

        thermalBox.appendChild(biosRow('Safety Limits',
            '[' + formatVoltage(SAFE_OC.voltage) + ' / ' + formatRatio(SAFE_OC.multiplier) + ']'));
        thermalBox.appendChild(biosRow('Cooling Drivers',
            '[' + (status.cooling ? 'installed' : 'NOT_INSTALLED') + ']'));
        thermalBox.appendChild(biosRowNode('Thermal Override', state.thermalEl));
        thermalBox.appendChild(state.thermalCauseEl);
        thermalBox.appendChild(actionRow('Restore Defaults (Ctrl+Alt+R)',
            'COOL DOWN', function () { emergencyReset(); }).row);

        if (status.active) {
            thermalBox.appendChild(el('div', 'bios-alert',
                'EMERGENCY: ' + status.text + ' — частота срезана на 30%. После Save & Exit ' +
                'экран начнёт сыпаться артефактами: выход один — Ctrl+Alt+R или значения ниже.'));
        }
        content.appendChild(thermalBox);

        syncOverclockFlag();          // строка "Overclocked" берёт значение реестра
        evaluateThermal();            // перегрев считается, артефакты ждут перезагрузки
        paintThermalReadout(overheatState());
    }

    /* --- 10a. Ползунки: одна механика для CPU и для памяти ---------------- */
    function fieldLimits(section, field) {
        return (section === 'mem') ? MEM_LIMITS[field] : OC_LIMITS[field];
    }

    function fieldTarget(section) {
        return (section === 'mem') ? state.mem : state.oc;
    }

    function formatField(field, value) {
        if (field === 'voltage' || field === 'dram_voltage') { return formatVoltage(value); }
        if (field === 'multiplier') { return formatRatio(value); }
        if (field === 'freq_mhz')   { return 'DDR4-' + Math.round(value); }
        return 'CL' + Math.round(value);
    }

    function fieldFormatter(field) {
        return function (value) { return formatField(field, value); };
    }

    function roundField(field, value) {
        if (field === 'voltage' || field === 'dram_voltage') {
            return Math.round(value * 1000) / 1000;
        }
        return Math.round(value);
    }

    /* Красная зона: цифра краснеет ещё до того, как машина начнёт сыпаться. */
    function fieldDanger(section, field, value) {
        if (field === 'multiplier')   { return value > SAFE_OC.multiplier; }
        if (field === 'voltage')      { return value > SAFE_OC.voltage; }
        if (field === 'dram_voltage') { return value > SAFE_MEM.dram_voltage; }

        if (field === 'freq_mhz') { return memoryState().manual && value > SAFE_MEM.freq_mhz; }
        return memoryState().manual && value > SAFE_MEM.cl;
    }

    /* Строка разгона: подпись, ползунок, кнопки шага, ручной ввод и значение.
     * section: 'oc' — CPU, 'mem' — память. */
    function sliderRow(title, field, section) {
        var limits    = fieldLimits(section, field);
        var formatter = fieldFormatter(field);
        var value     = fieldTarget(section)[field];
        var row       = el('div', 'oc-row');
        var input     = el('input', 'oc-range');
        var manual    = el('input', 'oc-input');
        var readout   = el('span', 'oc-value' + (fieldDanger(section, field, value) ? ' is-danger' : ''),
            formatter(value));
        var minus     = button('oc-step', '\u2212');
        var plus      = button('oc-step', '+');

        input.type  = 'range';
        input.min   = String(limits.min);
        input.max   = String(limits.max);
        input.step  = String(limits.step);
        input.value = String(value);

        manual.type  = 'number';
        manual.min   = String(limits.min);
        manual.max   = String(limits.max);
        manual.step  = String(limits.step);
        manual.value = String(value);

        input.addEventListener('input', function () {
            applyField(section, field, parseFloat(input.value), readout, manual);
        });
        manual.addEventListener('change', function () {
            applyField(section, field, parseFloat(manual.value), readout, input);
        });
        minus.addEventListener('click', function () { bumpField(section, field, -1, input, manual); });
        plus.addEventListener('click', function () { bumpField(section, field, 1, input, manual); });

        row.appendChild(el('span', 'oc-row-title', title));
        row.appendChild(input);
        row.appendChild(minus);
        row.appendChild(plus);
        row.appendChild(manual);
        row.appendChild(readout);
        return row;
    }

    /* Кнопки + / − двигают значение на шаг, как клавиши в настоящем Setup. */
    function bumpField(section, field, direction, input, manual) {
        var limits = fieldLimits(section, field);
        var fixed  = roundField(field, parseFloat(input.value) + (direction * limits.step));

        if (fixed < limits.min || fixed > limits.max) { return; }

        input.value  = String(fixed);
        manual.value = String(fixed);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /* Значение уходит в NVRAM сразу и тут же пересчитывает термозащиту. */
    function applyField(section, field, value, readout, mirror) {
        var limits = fieldLimits(section, field);
        var target = fieldTarget(section);

        if (isNaN(value)) { return; }

        if (value < limits.min) { value = limits.min; }
        if (value > limits.max) { value = limits.max; }
        value = roundField(field, value);

        /* Тронули частоту руками — профиль сам становится Manual. */
        if (section === 'mem' && state.mem.xmp !== 'Manual') { state.mem.xmp = 'Manual'; }

        target[field] = value;

        if (mirror) { mirror.value = String(value); }

        readout.textContent = formatField(field, value);
        readout.className   = fieldDanger(section, field, value) ? 'oc-value is-danger' : 'oc-value';

        writeJSON((section === 'mem') ? MEMORY_KEY : OC_KEY, target);

        updateMetrics();
        syncOverclockFlag();      // реестр узнаёт про разгон сразу
        evaluateThermal();        // перегрев включается и гаснет на лету
    }

    /* Частоты в шапке: цифры всегда синхронны с NVRAM. */
    function updateMetrics() {
        if (state.voltEl)      { state.voltEl.textContent      = formatVoltage(state.oc.voltage); }
        if (state.ratioEl)     { state.ratioEl.textContent     = formatRatio(state.oc.multiplier); }
        if (state.memMetricEl) { state.memMetricEl.textContent = memoryMetricText(); }
    }

    function memoryMetricText() {
        return '4096 MB DDR4-' + memoryState().freq_mhz;
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
            'Current ROM: ' + PA_VERSION + ' Rev. ' + BIOS_REV + ' (' + BIOS_BUILD + ')'));

        pick = button('mflash-btn', 'Select ROM file');
        pick.disabled = true;
        box.appendChild(pick);

        content.appendChild(box);
    }

    /* --- 13. Вкладка SAVE & EXIT ------------------------------------------ */
    function renderExit() {
        var content = state.contentEl;
        var mem     = memoryState();
        var list, override, i;

        content.appendChild(el('h2', 'uefi-title', 'SAVE & EXIT'));

        list = el('div', 'exit-list');
        list.appendChild(exitButton('Save Changes and Reset', true, function () {
            saveAndExit();
        }));
        list.appendChild(exitButton('Exit without Saving (Reset)', false, function () {
            exitWithoutSaving();
        }));
        list.appendChild(exitButton('Discard Changes and Reset', false, function () {
            restoreDefaults();
            exitWithoutSaving();
        }));
        list.appendChild(exitButton('Restore Defaults', false, function () {
            restoreDefaults();
            switchTab('exit');
        }));

        /* Boot Override — на один запуск: грузимся с выбранного устройства. */
        for (i = 0; i < BOOT_DEVICES.length; i++) {
            list.appendChild(bootOverrideButton(BOOT_DEVICES[i]));
        }
        content.appendChild(list);

        override = groupBox('Boot Override / NVRAM');
        for (i = 0; i < state.bootOrder.length; i++) {
            override.appendChild(biosRow('Override #' + (i + 1),
                '[' + state.bootOrder[i] + ']'));
        }
        override.appendChild(biosRow('NVRAM surgeon_boot_order', '[saved]'));
        override.appendChild(biosRow('NVRAM surgeon_bios_oc',
            '[' + formatVoltage(state.oc.voltage) + ' / ' + formatRatio(state.oc.multiplier) + ']'));
        override.appendChild(biosRow('NVRAM surgeon_bios_memory',
            '[XMP ' + mem.xmp + ' / DDR4-' + mem.freq_mhz + ' / ' +
            formatVoltage(mem.voltage) + ' / CL' + mem.cl + ']'));
        override.appendChild(biosRow('NVRAM surgeon_bios_storage',
            '[SATA ' + state.storage.sata_mode + ' / bridge ' + boolLabel(!!state.storage.vdfs_bridge) + ']'));
        override.appendChild(biosRow('NVRAM surgeon_bios_usb',
            '[Legacy USB ' + boolLabel(!!state.usb.legacy_usb) + ']'));
        override.appendChild(biosRow('NVRAM surgeon_bios_security',
            '[Secure Boot ' + boolLabel(!!state.security.secure_boot) + ']'));
        override.appendChild(biosRow('NVRAM surgeon_bios_overheat',
            '[armed: ' + (overheatArmed() ? 'true' : 'false') +
            ' / active: ' + (overheatState().active ? 'true' : 'false') + ']'));
        override.appendChild(biosRow('Setup Checklist',
            '[' + (REQUIRED_SETUP.length - pendingSetupItems().length) + '/' +
            REQUIRED_SETUP.length + ' done]'));
        override.appendChild(biosRow('SurgeonDiskReady', '[' + diskReadyText() + ']'));
        override.appendChild(biosRow('Process Table', '[' + processCount() + ' active]'));
        override.appendChild(biosNote(
            'Любой выход отсюда — перезагрузка: сначала POST, потом GRUB или ошибка.'));
        override.appendChild(biosNote(
            'Save Changes взводит разгон: после перезагрузки машина стартует нестабильной ' +
            '(если вышли за лимиты) или заметно быстрее (если нет).'));
        override.appendChild(biosNote(
            'POST проверит Setup Checklist и разгон: при проблеме — ошибка на 2 секунды ' +
            'и возврат сюда же.'));
        content.appendChild(override);
    }

    /* Кнопка override: устройство разово встаёт первым, NVRAM не меняется. */
    function bootOverrideButton(device) {
        return exitButton('Boot Override: ' + device, false, function () {
            saveAndExit(device);
        });
    }

    function exitButton(label, primary, handler) {
        var node = button('exit-btn' + (primary ? ' is-primary' : ''), label);
        node.addEventListener('click', handler);
        return node;
    }

    /* Сброс к заводским: память модуля и все записи NVRAM. */
    function restoreDefaults() {
        state.bootOrder = DEFAULT_BOOT_ORDER.slice();
        state.oc        = {
            voltage:    DEFAULT_OC.voltage,
            multiplier: DEFAULT_OC.multiplier
        };
        state.mem       = {
            xmp:          DEFAULT_MEMORY.xmp,
            freq_mhz:     DEFAULT_MEMORY.freq_mhz,
            dram_voltage: DEFAULT_MEMORY.dram_voltage,
            cl:           DEFAULT_MEMORY.cl
        };
        state.storage   = { sata_mode: DEFAULT_SATA.sata_mode, vdfs_bridge: DEFAULT_SATA.vdfs_bridge };
        state.usb       = { legacy_usb: DEFAULT_USB.legacy_usb };
        state.security  = { secure_boot: DEFAULT_SECURE.secure_boot };

        writeJSON(BOOT_ORDER_KEY, DEFAULT_BOOT_ORDER);
        writeJSON(OC_KEY, DEFAULT_OC);
        writeJSON(MEMORY_KEY, state.mem);
        writeJSON(SATA_KEY, state.storage);
        writeJSON(USB_KEY, state.usb);
        writeJSON(SECURE_KEY, state.security);

        /* Журнал чистится вместе с разгоном: температура в норме, артефакты сняты. */
        writeOverheatRecord(overheatState(), false);

        applyRegistryFlags();
        updateMetrics();
        syncOverclockFlag();          // реестр: разгон выключен
        paintStatusFlags();
    }

    /* --- 14. Часы в шапке -------------------------------------------------- */
    function tickClock() {
        if (!state.clockEl) { return; }

        var now = new Date();
        state.clockEl.textContent =
            pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    }

    /* --- 15. Выход и точка входа ------------------------------------------ */
    /* Любой выход = перезагрузка: страница стартует заново, POST проверяет
     * машину и либо отдаёт эстафету GRUB, либо показывает ошибку и возвращает
     * в Setup. armed (Save Changes) взводит артефакты разгона после POST.
     * deviceOverride — разовый Boot Override: в NVRAM он не попадает. */
    function exitSetup(armed, deviceOverride) {
        var reason = bootFailureReason(deviceOverride);
        var killed = resetProcesses();

        if (armed) {
            armThermal();
            console.log('[CLICK BIOS] Save & Exit: thermal override armed (' +
                overheatState().text + ')');
        } else {
            disarmThermal();
            console.log('[CLICK BIOS] Exit without saving: artifacts disarmed');
        }

        console.log('[CLICK BIOS] reboot: ' + killed + ' process(es) killed');

        /* Грузиться нечему: Setup гаснет, машина уходит в чёрный экран. */
        if (reason) {
            console.error('[CLICK BIOS] boot guard: ' + reason);
            showNoBootableDevice(reason);
            return;
        }

        destroy();
        reboot();
    }

    /* Save Changes and Reset (F10). */
    function saveAndExit(deviceOverride) {
        exitSetup(true, deviceOverride);
    }

    /* Exit without Saving: значения уже в NVRAM, но артефакты не взводим. */
    function exitWithoutSaving(deviceOverride) {
        exitSetup(false, deviceOverride);
    }

    /* Перезагрузка: событие для оркестратора плюс перезапуск страницы.
     * SurgeonSimReboot = true глушит reload в дым-тесте. */
    function reboot() {
        document.dispatchEvent(new CustomEvent('surgeon_reboot'));

        if (window.SurgeonSimReboot === true) { return; }
        window.location.reload();
    }

    /* Аварийный сброс перегрева: убирает разгон за лимитами и журнал, но НЕ
     * трогает настройки, без которых машина не загрузится (XMP, Boot Priority,
     * SATA, USB, Secure Boot). Иначе Ctrl+Alt+R сносил XMP — пункт чек-листа —
     * и человек оставался в цикле Setup -> POST -> Setup. */
    function clearThermalOverride() {
        var oc      = (state.oc && typeof state.oc.voltage === 'number') ? state.oc : loadOC();
        var mem     = memoryProfile();
        var clamped = false;

        if (oc.voltage > SAFE_OC.voltage)       { oc.voltage = DEFAULT_OC.voltage;       clamped = true; }
        if (oc.multiplier > SAFE_OC.multiplier) { oc.multiplier = DEFAULT_OC.multiplier; clamped = true; }

        /* Напряжение DRAM выше лимита держит профиль XMP: возвращаем паспорт. */
        if (mem.dram_voltage > SAFE_MEM.dram_voltage) {
            mem.dram_voltage = DEFAULT_MEMORY.dram_voltage;
            clamped = true;
        }
        if (mem.xmp === 'Manual') {
            if (mem.freq_mhz > SAFE_MEM.freq_mhz) { mem.freq_mhz = DEFAULT_MEMORY.freq_mhz; clamped = true; }
            if (mem.cl > SAFE_MEM.cl)             { mem.cl = DEFAULT_MEMORY.cl;             clamped = true; }
        }

        state.oc  = { voltage: oc.voltage, multiplier: oc.multiplier };
        state.mem = mem;

        writeJSON(OC_KEY, state.oc);
        writeJSON(MEMORY_KEY, state.mem);

        disarmThermal();               // журнал: armed = false, артефактов больше нет
        updateMetrics();
        syncOverclockFlag();
        evaluateThermal();

        console.warn('[CLICK BIOS] Thermal override cleared: overclock ' +
            (clamped ? 'clamped to safe values' : 'was already safe') +
            ', setup checklist kept (XMP ' + state.mem.xmp + ')');
        return clamped;
    }

    /* Ctrl+Alt+R: аварийный выход из перегрева. Гасит артефакты и сбрасывает
     * разгон за лимитами — настройки машины остаются на месте. */
    function emergencyReset() {
        stopThermalArtifacts();
        removeThermalBanner();
        clearThermalOverride();     // разгон и журнал: чек-лист остаётся целым
        switchTab(state.tab);       // вкладка перерисовывается с новыми цифрами

        console.warn('[CLICK BIOS] EMERGENCY RESET (Ctrl+Alt+R): overclock clamped, ' +
            'thermal override disarmed, NVRAM settings kept');
        showNotice('Ctrl+Alt+R: разгон за лимитами сброшен, артефакты сняты. ' +
            'XMP и порядок загрузки сохранены.');
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

        stopThermalArtifacts();
        removeThermalBanner();

        if (state.container && state.container.parentNode) {
            state.container.parentNode.removeChild(state.container);
        }

        state.container     = null;
        state.contentEl     = null;
        state.helpEl        = null;
        state.clockEl       = null;
        state.voltEl        = null;
        state.ratioEl       = null;
        state.memMetricEl   = null;
        state.ocFlagEl      = null;
        state.ocStatusEl    = null;
        state.memStatusEl   = null;
        state.memUnstableEl = null;
        state.statusCheckEl = null;
        state.checkRowEls   = {};
        state.setupBannerEl = null;
        state.tabs          = [];
    }

    function init() {
        destroy();                     // повторный вход начинается с чистого листа

        /* Обнуляем диспетчер задач симулятора. */
        console.log('[CLICK BIOS] init: process table reset (' + resetProcesses() + ' killed)');

        state.bootOrder = loadBootOrder();
        state.oc        = loadOC();
        state.mem       = loadMemory();
        loadPlatformSettings();        // SATA / Legacy USB / Secure Boot из NVRAM

        registry();                    // реестр BIOS обязан существовать до отрисовки
        syncOverclockFlag();
        applyRegistryFlags();

        state.container = buildShell();
        document.body.appendChild(state.container);

        tickClock();
        state.clockTimer = window.setInterval(tickClock, 1000);

        /* F10 — Save & Exit, ESC — выход без сохранения,
         * Ctrl+Alt+R — аварийный сброс из перегрева. */
        state.keyHandler = function (event) {
            var code = event.keyCode || event.which;
            var key  = event.key || '';

            if (code === KEY_F10 || key === 'F10') {
                event.preventDefault();
                saveAndExit();
                return;
            }

            if (code === KEY_ESC || key === 'Escape') {
                event.preventDefault();
                exitWithoutSaving();
                return;
            }

            if ((event.ctrlKey && event.altKey) && (code === KEY_R || key === 'r' || key === 'R')) {
                event.preventDefault();
                emergencyReset();
            }
        };
        window.addEventListener('keydown', state.keyHandler, true);

        switchTab('settings');
        evaluateThermal();             // перегрев считается, артефакты ждут перезагрузки
    }

    /* Наружу: вход, выход, перезагрузка и проверка загрузки. */
    window.SurgeonClickBios = {
        init:    init,
        destroy: destroy,
        save:    saveAndExit,         // Save & Exit: взводит разгон и перезагружает
        exit:    exitWithoutSaving,   // выход без сохранения
        reload:  exitSetup,
        reboot:  reboot
    };

    /* Движок артефактов: им пользуется экран POST. severity — 1..3. */
    window.SurgeonOverheat = {
        state:  overheatState,
        start:  startThermalArtifacts,
        stop:   stopThermalArtifacts,
        record: readOverheatRecord,
        armed:  overheatArmed,
        limits: function () { return { cpu: SAFE_OC, memory: SAFE_MEM }; }
    };

    /* Чек-лист: POST спрашивает pending(), пока список не пуст. */
    window.SurgeonSetupCheck = {
        pending: pendingSetupItems,
        total:   function () { return REQUIRED_SETUP.length; },
        done:    setupChecklistDone,
        items:   function () {
            var out = [];
            var i;

            for (i = 0; i < REQUIRED_SETUP.length; i++) {
                out.push({
                    id:    REQUIRED_SETUP[i].id,
                    label: REQUIRED_SETUP[i].label,
                    done:  REQUIRED_SETUP[i].done()
                });
            }
            return out;
        }
    };

    /* Проверка "есть ли что грузить": её вызывает POST перед GRUB.
     * show() — тот же чёрный экран, что и при Save & Exit без ОС. */
    window.SurgeonBootGuard = {
        order:   firstBootDevice,
        check:   bootFailureReason,
        show:    showNoBootableDevice,
        distros: installedDistros,
        signed:  signedDistroCount
    };
})(window, document);
