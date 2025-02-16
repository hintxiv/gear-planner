import {
    ALL_SUB_STATS,
    EMPTY_STATS,
    FAKE_MAIN_STATS,
    getLevelStats,
    getRaceStats,
    JobName,
    MAIN_STATS,
    MATERIA_ACCEPTABLE_OVERCAP_LOSS,
    MATERIA_LEVEL_MAX_NORMAL,
    MATERIA_LEVEL_MAX_OVERMELD,
    MATERIA_LEVEL_MIN_RELEVANT,
    MATERIA_SLOTS_MAX,
    MateriaSubstat,
    NORMAL_GCD,
    RaceName,
    SPECIAL_SUB_STATS,
    statById,
} from "./xivconstants";
import {
    autoDhBonusDmg,
    critChance,
    critDmg,
    detDmg,
    dhitChance,
    dhitDmg,
    mainStatMulti,
    mpTick,
    sksTickMulti,
    sksToGcd,
    spsTickMulti,
    spsToGcd,
    tenacityDmg,
    wdMulti
} from "./xivmath";
import {
    ComputedSetStats,
    DisplayGearSlot,
    DisplayGearSlotInfo,
    DisplayGearSlotKey,
    EquipmentSet,
    EquipSlotKey,
    EquipSlots,
    FoodItem,
    GearItem,
    Materia,
    MateriaAutoFillController,
    MateriaAutoFillPrio,
    MateriaSlot,
    MeldableMateriaSlot,
    OccGearSlotKey,
    RawStatKey,
    RawStats,
    StatBonus,
    Substat,
    XivCombatItem
} from "./geartypes";
import {GearPlanSheet} from "./components";
import {xivApiIcon} from "./external/xivapi";
import {IlvlSyncInfo} from "./datamanager";
import {XivApiStat, xivApiStatMapping} from "./external/xivapitypes";


export class EquippedItem {

    gearItem: GearItem;
    melds: MeldableMateriaSlot[];
    relicStats?: {
        [K in Substat]?: number
    };

    constructor(gearItem: GearItem, melds: MeldableMateriaSlot[] | undefined = undefined) {
        this.gearItem = gearItem;
        if (melds === undefined) {
            this.melds = [];
            for (let materiaSlot of gearItem.materiaSlots) {
                this.melds.push({
                    materiaSlot: materiaSlot,
                    equippedMateria: null
                })
            }
        }
        else {
            this.melds = [...melds];
        }
        if (gearItem.isCustomRelic) {
            this.relicStats = {};
        }
    }
}

/**
 * Class representing equipped gear, food, and other overrides.
 */
export class CharacterGearSet {
    private _name: string;
    private _description: string;
    equipment: EquipmentSet;
    listeners: (() => void)[] = [];
    private _dirtyComp: boolean = true;
    private _updateKey: number = 0;
    private _computedStats: ComputedSetStats;
    private _jobOverride: JobName;
    private _raceOverride: RaceName;
    private _food: FoodItem;
    private _sheet: GearPlanSheet;

    constructor(sheet: GearPlanSheet) {
        this._sheet = sheet;
        this.name = ""
        this.equipment = new EquipmentSet();
    }

    get updateKey() {
        return this._updateKey;
    }


    get name() {
        return this._name;
    }

    set name(name) {
        this._name = name;
        this.notifyListeners();
    }

    get description() {
        return this._description;
    }

    set description(desc) {
        this._description = desc;
        this.notifyListeners();
    }



    get food(): FoodItem | undefined {
        return this._food;
    }

    private invalidate() {
        this._dirtyComp = true;
        this._updateKey++;
    }

    set food(food: FoodItem | undefined) {
        this.invalidate();
        this._food = food;
        console.log(`Set ${this.name}: food => ${food?.name}`);
        this.notifyListeners();
    }

    setEquip(slot: EquipSlotKey, item: GearItem, materiaAutoFill?: MateriaAutoFillController) {
        // TODO: this is also a good place to implement temporary persistent materia/relic stats
        if (this.equipment[slot]?.gearItem === item) {
            return;
        }
        this.invalidate();
        this.equipment[slot] = new EquippedItem(item);
        console.log(`Set ${this.name}: slot ${slot} => ${item.name}`);
        if (materiaAutoFill && materiaAutoFill.autoFillNewItem) {
            this.fillMateria(materiaAutoFill.prio, false, [slot]);
        }
        this.notifyListeners()
    }

    private notifyListeners() {
        for (let listener of this.listeners) {
            listener();
        }
    }


    forceRecalc() {
        this.invalidate();
        this.notifyListeners();
    }

    addListener(listener: () => void) {
        this.listeners.push(listener);
    }

    getItemInSlot(slot: keyof EquipmentSet): GearItem | null {
        const inSlot = this.equipment[slot];
        if (inSlot === null || inSlot === undefined) {
            return null;
        }

        return inSlot.gearItem;
    }

    get allEquippedItems(): XivCombatItem[] {
        return Object.values(this.equipment)
            .filter(slotEquipment => slotEquipment && slotEquipment.gearItem)
            .map((slotEquipment: EquippedItem) => slotEquipment.gearItem);
    }

    get computedStats(): ComputedSetStats {
        if (!this._dirtyComp) {
            return this._computedStats;
        }
        const combinedStats = new RawStats(EMPTY_STATS);
        const classJob = this._jobOverride ?? this._sheet.classJobName;
        const classJobStats = this._jobOverride ? this._sheet.statsForJob(this._jobOverride) : this._sheet.classJobStats;
        const raceStats = this._raceOverride ? getRaceStats(this._raceOverride) : this._sheet.raceStats;
        const level = this._sheet.level;
        const levelStats = getLevelStats(level);

        // Base stats based on job and level
        for (let statKey of MAIN_STATS) {
            combinedStats[statKey] = Math.floor(levelStats.baseMainStat * classJobStats.jobStatMultipliers[statKey] / 100);
        }
        for (let statKey of FAKE_MAIN_STATS) {
            combinedStats[statKey] = Math.floor(levelStats.baseMainStat);
        }
        for (let statKey of SPECIAL_SUB_STATS) {
            combinedStats[statKey] = Math.floor(levelStats.baseSubStat);
        }

        // Add race stats
        addStats(combinedStats, raceStats);

        // Item stats
        for (let key of EquipSlots) {
            if (this.equipment[key]) {
                addStats(combinedStats, this.getSlotEffectiveStats(key));
            }
        }
        // Food stats
        if (this._food) {
            for (let stat in this._food.bonuses) {
                const bonus: StatBonus = this._food.bonuses[stat];
                const startingValue = combinedStats[stat];
                const extraValue = Math.min(bonus.max, Math.floor(startingValue * (bonus.percentage / 100)));
                combinedStats[stat] = startingValue + extraValue;
            }
        }
        const mainStat = Math.floor(combinedStats[classJobStats.mainStat] * (1 + 0.01 * this._sheet.partyBonus));
        this._computedStats = {
            ...combinedStats,
            level: level,
            levelStats: levelStats,
            job: classJob,
            jobStats: classJobStats,
            gcdPhys: base => sksToGcd(base, levelStats, combinedStats.skillspeed),
            gcdMag: base => spsToGcd(base, levelStats, combinedStats.spellspeed),
            critChance: critChance(levelStats, combinedStats.crit),
            critMulti: critDmg(levelStats, combinedStats.crit),
            dhitChance: dhitChance(levelStats, combinedStats.dhit),
            dhitMulti: dhitDmg(levelStats, combinedStats.dhit),
            detMulti: detDmg(levelStats, combinedStats.determination),
            spsDotMulti: spsTickMulti(levelStats, combinedStats.spellspeed),
            sksDotMulti: sksTickMulti(levelStats, combinedStats.skillspeed),
            tncMulti: tenacityDmg(levelStats, combinedStats.tenacity),
            // TODO: does this need to be phys/magic split?
            wdMulti: wdMulti(levelStats, classJobStats, Math.max(combinedStats.wdMag, combinedStats.wdPhys)),
            mainStatMulti: mainStatMulti(levelStats, classJobStats, mainStat),
            traitMulti: classJobStats.traitMulti ? (type) => classJobStats.traitMulti(level, type) : () => 1,
            autoDhBonus: autoDhBonusDmg(levelStats, combinedStats.dhit),
            mpPerTick: mpTick(levelStats, combinedStats.piety),
        }
        if (classJobStats.traits) {
            classJobStats.traits.forEach(trait => {
                if (trait.minLevel && trait.minLevel > level) {
                    return;
                }
                if (trait.maxLevel && trait.maxLevel < level) {
                    return;
                }
                trait.apply(this._computedStats);
            });
        }
        this._dirtyComp = false;
        console.info("Recomputed stats");
        return this._computedStats;
    }

    getSlotEffectiveStats(slotId: EquipSlotKey): RawStats {
        const equip = this.equipment[slotId];
        if (!equip.gearItem) {
            return EMPTY_STATS;
        }
        const itemStats = new RawStats(equip.gearItem.stats);
        if (equip.relicStats) {
            let relicStats = new RawStats(equip.relicStats);
            if (equip.gearItem.isSyncedDown) {
                relicStats = applyStatCaps(relicStats, equip.gearItem.statCaps);
            }
            addStats(itemStats, relicStats);
        }
        // Note for future: if we ever get an item that has both custom stats AND materia, this logic will need to be extended.
        else {
            for (let stat of ALL_SUB_STATS) {
                const statDetail = this.getStatDetail(slotId, stat);
                if (statDetail instanceof Object) {
                    itemStats[stat] = statDetail.effectiveAmount;
                }
                else {
                    itemStats[stat] = statDetail;
                }
            }
        }
        return itemStats;
    }

    getStatDetail(slotId: keyof EquipmentSet, stat: RawStatKey, materiaOverride?: Materia[]): ItemSingleStatDetail | number {
        // TODO: work this into the normal stat computation method
        const equip = this.equipment[slotId];
        const gearItem = equip.gearItem;
        if (!gearItem) {
            return 0;
        }
        if (gearItem.isSyncedDown) {
            const unsynced = gearItem.unsyncedVersion.stats[stat];
            const synced = gearItem.stats[stat];
            if (synced < unsynced) {
                return {
                    effectiveAmount: synced,
                    fullAmount: unsynced,
                    overcapAmount: unsynced - synced,
                    cap: synced,
                    mode: "synced-down"
                }
            }
            else {
                return synced;
            }
        }
        const cap = gearItem.statCaps[stat] ?? 9999;
        const baseItemStatValue = gearItem.stats[stat];
        let meldedStatValue = baseItemStatValue;
        let smallestMateria = 999999;
        const materiaList = materiaOverride === undefined ? equip.melds.map(meld => meld.equippedMateria).filter(item => item) : materiaOverride.filter(item => item);
        for (let materia of materiaList) {
            const materiaStatValue = materia.stats[stat];
            if (materiaStatValue > 0) {
                meldedStatValue += materiaStatValue;
                smallestMateria = Math.min(smallestMateria, materiaStatValue);
            }
        }
        // Not melded or melds are not relevant to this stat
        if (meldedStatValue === baseItemStatValue) {
            return meldedStatValue;
        }
        // Overcapped
        const overcapAmount = meldedStatValue - cap;
        if (overcapAmount <= 0) {
            return {
                effectiveAmount: meldedStatValue,
                fullAmount: meldedStatValue,
                overcapAmount: 0,
                cap: cap,
                mode: "melded",
            }
        }
        else if (overcapAmount < smallestMateria) {
            return {
                effectiveAmount: cap,
                fullAmount: meldedStatValue,
                overcapAmount: overcapAmount,
                cap: cap,
                mode: "melded-overcapped",
            }
        }
        else {
            return {
                effectiveAmount: cap,
                fullAmount: meldedStatValue,
                overcapAmount: overcapAmount,
                cap: cap,
                mode: "melded-overcapped-major",
            }
        }
    }

    /**
     * Perform a materia auto-fill.
     *
     * @param prio The priority of stats.
     * @param overwrite true to fill all slots, even if already occupied. false to only fill empty slots.
     * @param slots Omit to fill all slots. Specify one or more slots to specifically fill those slots.
     */
    fillMateria(prio: MateriaAutoFillPrio, overwrite: boolean, slots?: EquipSlotKey[]) {
        const statPrio: MateriaSubstat[] = prio.statPrio;
        // If overwriting, first delete everything. We have to pre-delete everything so that the GCD-specific
        // logic won't remove SpS/SkS melds in materia on the first few items because it thinks we're good on speed
        // (since the materia are already there).
        if (overwrite) {
            for (let slotKey of (slots === undefined ? EquipSlots : slots)) {
                const equipSlot = this.equipment[slotKey] as EquippedItem | null;
                const gearItem = equipSlot?.gearItem;
                if (gearItem) {
                    equipSlot.melds.forEach(meldSlot => meldSlot.equippedMateria = null);
                }
            }
            this.forceRecalc();
        }
        for (let slotKey of (slots === undefined ? EquipSlots : slots)) {
            const equipSlot = this.equipment[slotKey] as EquippedItem | null;
            const gearItem = equipSlot?.gearItem;
            if (gearItem) {
                materiaLoop: for (let meldSlot of equipSlot.melds) {
                    // If overwriting, we already cleared the slots, so this check is fine in any scenario.
                    if (meldSlot.equippedMateria) {
                        continue;
                    }
                    const slotStats = this.getSlotEffectiveStats(slotKey);
                    // TODO: we also have gearItem.substatCap we can use to make it more direct
                    for (let stat of statPrio) {
                        if (stat === 'skillspeed') {
                            if (this.computedStats.gcdPhys(NORMAL_GCD) <= prio.minGcd) {
                                continue;
                            }
                            this.forceRecalc();
                            if (this.computedStats.gcdPhys(NORMAL_GCD) <= prio.minGcd) {
                                continue;
                            }
                        }
                        if (stat === 'spellspeed') {
                            // Check if we're already there before forcing a recomp
                            if (this.computedStats.gcdMag(NORMAL_GCD) <= prio.minGcd) {
                                continue;
                            }
                            this.forceRecalc();
                            if (this.computedStats.gcdMag(NORMAL_GCD) <= prio.minGcd) {
                                continue;
                            }
                        }
                        const newMateria: Materia = this._sheet.getBestMateria(stat, meldSlot);
                        if (!newMateria) {
                            continue;
                        }
                        // TODO make this a setting?
                        // console.log(`Materia Fill: ${stat} ${newMateria.primaryStatValue} ${slotStats[stat]} ${cap}`);
                        // Allow for losing 1 or 2 stat points
                        const cap = gearItem.statCaps[stat] ?? (() => {
                            console.error(`Failed to calculate substat cap for ${stat} on ${gearItem.id} (${gearItem.id})`);
                            return 1000;
                        })();
                        if (newMateria.primaryStatValue + slotStats[stat] - MATERIA_ACCEPTABLE_OVERCAP_LOSS < cap) {
                            meldSlot.equippedMateria = newMateria;
                            continue materiaLoop;
                        }
                    }
                }
            }
        }
        this.forceRecalc();
    }

    isStatRelevant(stat: RawStatKey) {
        return this._sheet.isStatRelevant(stat);
    }
}

export function applyStatCaps(stats: RawStats, statCaps: {[K in RawStatKey]?: number}) {
    const out = {
        ...stats
    }
    Object.entries(stats).forEach(([stat, value]) => {
        out[stat] = Math.min(value, statCaps[stat] ?? 999999);
    })
    return out;
}

export interface ItemSingleStatDetail {
    effectiveAmount: number,
    fullAmount: number,
    overcapAmount: number,
    cap: number,
    mode: 'unmelded' | 'melded' | 'melded-overcapped' | 'melded-overcapped-major' | 'synced-down';
}

/**
 * Adds the stats of 'addedStats' into 'baseStats'.
 *
 * Modifies 'baseStats' in-place.
 *
 * @param baseStats  The base stat sheet. Will be modified.
 * @param addedStats The stats to add.
 */
function addStats(baseStats: RawStats, addedStats: RawStats): void {
    for (let entry of Object.entries(baseStats)) {
        const stat = entry[0] as keyof RawStats;
        baseStats[stat] = addedStats[stat] + (baseStats[stat] ?? 0);
    }
}

export class XivApiGearInfo implements GearItem {
    id: number;
    name: string;
    /**
     * Raw 'Stats' object from Xivapi
     */
    Stats: Object;
    iconUrl: URL;
    ilvl: number;
    displayGearSlot: DisplayGearSlot;
    displayGearSlotName: DisplayGearSlotKey;
    occGearSlotName: OccGearSlotKey;
    stats: RawStats;
    primarySubstat: keyof RawStats | null;
    secondarySubstat: keyof RawStats | null;
    materiaSlots: MateriaSlot[];
    isCustomRelic: boolean;
    unsyncedVersion: XivApiGearInfo;
    statCaps: {
        [K in RawStatKey]?: number
    };
    isSyncedDown: boolean;

    constructor(data: Object) {
        this.id = data['ID'];
        this.name = data['Name'];
        this.ilvl = data['LevelItem'];
        this.iconUrl = xivApiIcon(data['IconHD']);
        this.Stats = data['Stats'];
        const eqs = data['EquipSlotCategory'];
        if (!eqs) {
            console.error('EquipSlotCategory was null!', data);
        }
        else if (eqs['MainHand']) {
            this.displayGearSlotName = 'Weapon';
            if (eqs['OffHand']) {
                this.occGearSlotName = 'Weapon2H'
            }
            else {
                this.occGearSlotName = 'Weapon1H';
            }
        }
        else if (eqs['OffHand']) {
            this.displayGearSlotName = 'OffHand';
            this.occGearSlotName = 'OffHand';
        }
        else if (eqs['Head']) {
            this.displayGearSlotName = 'Head';
            this.occGearSlotName = 'Head';
        }
        else if (eqs['Body']) {
            this.displayGearSlotName = 'Body';
            this.occGearSlotName = 'Body';
        }
        else if (eqs['Gloves']) {
            this.displayGearSlotName = 'Hand';
            this.occGearSlotName = 'Hand';
        }
        else if (eqs['Legs']) {
            this.displayGearSlotName = 'Legs';
            this.occGearSlotName = 'Legs';
        }
        else if (eqs['Feet']) {
            this.displayGearSlotName = 'Feet';
            this.occGearSlotName = 'Feet';
        }
        else if (eqs['Ears']) {
            this.displayGearSlotName = 'Ears';
            this.occGearSlotName = 'Ears';
        }
        else if (eqs['Neck']) {
            this.displayGearSlotName = 'Neck';
            this.occGearSlotName = 'Neck';
        }
        else if (eqs['Wrists']) {
            this.displayGearSlotName = 'Wrist';
            this.occGearSlotName = 'Wrist';
        }
        else if (eqs['FingerL'] || eqs['FingerR']) {
            this.displayGearSlotName = 'Ring';
            this.occGearSlotName = 'Ring';
        }
        else {
            console.error("Unknown slot data!", eqs);
        }
        this.displayGearSlot = this.displayGearSlotName ? DisplayGearSlotInfo[this.displayGearSlotName] : undefined;

        this.stats = {
            vitality: this.getStatRaw("Vitality"),
            strength: this.getStatRaw("Strength"),
            dexterity: this.getStatRaw("Dexterity"),
            intelligence: this.getStatRaw("Intelligence"),
            mind: this.getStatRaw("Mind"),
            piety: this.getStatRaw("Piety"),
            crit: this.getStatRaw("CriticalHit"),
            dhit: this.getStatRaw("DirectHitRate"),
            determination: this.getStatRaw("Determination"),
            tenacity: this.getStatRaw("Tenacity"),
            spellspeed: this.getStatRaw("SpellSpeed"),
            skillspeed: this.getStatRaw("SkillSpeed"),
            wdPhys: data['DamagePhys'],
            wdMag: data['DamageMag'],
            hp: 0
        }
        if (data['CanBeHq']) {
            for (let i = 0; i <= 5; i++) {
                if (data[`BaseParamSpecial${i}TargetID`] === 12) {
                    this.stats.wdPhys += data[`BaseParamValueSpecial${i}`];
                }
                else if (data[`BaseParamSpecial${i}TargetID`] === 13) {
                    this.stats.wdMag += data[`BaseParamValueSpecial${i}`];
                }
            }
        }
        this.computeSubstats();
        this.materiaSlots = [];
        const baseMatCount: number = data['MateriaSlotCount'];
        if (baseMatCount === 0 && this.displayGearSlot !== DisplayGearSlotInfo.OffHand) {
            this.isCustomRelic = true;
        }
        else {
            this.isCustomRelic = false;
            const overmeld: boolean = data['IsAdvancedMeldingPermitted'] as boolean;
            for (let i = 0; i < baseMatCount; i++) {
                // TODO: figure out grade automatically
                this.materiaSlots.push({
                    maxGrade: MATERIA_LEVEL_MAX_NORMAL,
                    allowsHighGrade: true
                });
            }
            if (overmeld) {
                this.materiaSlots.push({
                    maxGrade: MATERIA_LEVEL_MAX_NORMAL,
                    allowsHighGrade: true
                })
                for (let i = this.materiaSlots.length; i < MATERIA_SLOTS_MAX; i++) {
                    this.materiaSlots.push({
                        maxGrade: MATERIA_LEVEL_MAX_OVERMELD,
                        allowsHighGrade: false
                    });
                }
            }
        }
    }

    private computeSubstats() {
        const sortedStats = Object.entries({
            crit: this.stats.crit,
            dhit: this.stats.dhit,
            determination: this.stats.determination,
            spellspeed: this.stats.spellspeed,
            skillspeed: this.stats.skillspeed,
            piety: this.stats.piety,
            tenacity: this.stats.tenacity,
        })
            .sort((left, right) => {
                if (left[1] > right[1]) {
                    return 1;
                }
                else if (left[1] < right[1]) {
                    return -1;
                }
                return 0;
            })
            .filter(item => item[1])
            .reverse();
        if (sortedStats.length < 2) {
            this.primarySubstat = null;
            this.secondarySubstat = null;
        }
        else {
            this.primarySubstat = sortedStats[0][0] as keyof RawStats;
            this.secondarySubstat = sortedStats[1][0] as keyof RawStats;
        }
    }

    /**
     * TODO fix docs for this
     */
    applyIlvlData(nativeIlvlInfo: IlvlSyncInfo, syncIlvlInfo?: IlvlSyncInfo) {
        const statCapsNative = {}
        Object.entries(this.stats).forEach(([stat, v]) => {
            statCapsNative[stat] = nativeIlvlInfo.substatCap(this.occGearSlotName, stat as RawStatKey);
        });
        this.statCaps = statCapsNative;
        if (syncIlvlInfo && syncIlvlInfo.ilvl < this.ilvl) {
            this.unsyncedVersion = {
                ...this
            };
            this.materiaSlots = [];
            const statCapsSync = {}
            Object.entries(this.stats).forEach(([stat, v]) => {
                statCapsSync[stat] = syncIlvlInfo.substatCap(this.occGearSlotName, stat as RawStatKey);
            });
            this.stats = applyStatCaps(this.stats, statCapsSync);
            this.statCaps = statCapsSync;
            this.computeSubstats();
            this.isSyncedDown = true;
        }
        else {
            this.unsyncedVersion = this;
            this.isSyncedDown = false;
        }
    }

    private getStatRaw(stat: XivApiStat) {
        const statValues = this.Stats[stat];
        if (statValues === undefined) {
            return 0;
        }
        if (statValues['HQ'] !== undefined) {
            return statValues['HQ'];
        }
        else {
            return statValues['NQ'];
        }
    }
}

export class XivApiFoodInfo implements FoodItem {
    bonuses: { [K in keyof RawStats]?: { percentage: number; max: number } } = {};
    iconUrl: URL;
    id: number;
    name: string;
    ilvl: number;
    primarySubStat: RawStatKey | undefined;
    secondarySubStat: RawStatKey | undefined;

    constructor(data: Object) {
        this.id = data['ID'];
        this.name = data['Name'];
        this.iconUrl = new URL("https://xivapi.com/" + data['IconHD']);
        this.ilvl = data['LevelItem'];
        for (let key in data['Bonuses']) {
            const bonusData = data['Bonuses'][key];
            this.bonuses[xivApiStatMapping[key as RawStatKey]] = {
                percentage: bonusData['ValueHQ'] ?? bonusData['Value'],
                max: bonusData['MaxHQ'] ?? bonusData['Max']
            }
        }
        const sortedStats = Object.entries(this.bonuses).sort((entryA, entryB) => entryB[1].max - entryA[1].max).map(entry => entry[0] as RawStatKey).filter(stat => stat !== 'vitality');
        if (sortedStats.length >= 1) {
            this.primarySubStat = sortedStats[0];
        }
        if (sortedStats.length >= 2) {
            this.secondarySubStat = sortedStats[1];
        }
    }

}

export function processRawMateriaInfo(data: Object): Materia[] {
    const out: Materia[] = []
    for (let i = MATERIA_LEVEL_MIN_RELEVANT - 1; i < MATERIA_LEVEL_MAX_NORMAL; i++) {
        const itemData = data['Item' + i];
        const itemName = itemData["Name"];
        const stats = new RawStats();
        const stat = statById(data['BaseParam']['ID']);
        if (!stat || !itemName) {
            continue;
        }
        stats[stat] = data['Value' + i];
        const grade = (i + 1);
        out.push({
            name: itemName,
            id: itemData["ID"],
            iconUrl: new URL("https://xivapi.com/" + itemData["IconHD"]),
            stats: stats,
            primaryStat: stat,
            primaryStatValue: stats[stat],
            materiaGrade: grade,
            isHighGrade: (grade % 2) === 0
        });
    }
    return out;
}

