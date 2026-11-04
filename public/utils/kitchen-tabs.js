import { t } from '/i18n.js';
import { api } from '/api.js';
import { renderSubTabs, setSubTabBadge, scrollActiveSubTabIntoView } from '/utils/sub-tabs.js';
import { MODULE_ICON, moduleIconEl } from '/nav-icons.js';
import { toLocalDateKey } from '/utils/date.js';

// Reihenfolge = Küchen-Kreislauf: planen → kochen → einkaufen → lagern.
export const KITCHEN_ROUTES = Object.freeze(['/sprint', '/meals', '/recipes', '/shopping', '/pantry']); // fork: '/sprint' (MENU.md)
export const KITCHEN_STORAGE_KEY = 'yuvomi-kitchen-tab';

// Modul-Namen der Gruppe, aus den Routen abgeleitet (`route.slice(1)`) - dieselbe
// Konvention, die `isModuleDisabled` unten schon nutzt. Einzige Quelle für die
// Frage „gehört dieses Modul zur Küche?", damit der geteilte Akzent nicht über
// eine zweite, driftende Liste läuft.
export const KITCHEN_MODULES = Object.freeze(KITCHEN_ROUTES.map((route) => route.slice(1)));

const TABS = () => [
  // fork: meal sprints (MENU.md). Fixed English label, so the 24 locale files stay untouched.
  { route: '/sprint',   label: 'Sprint',          icon: 'calendar-range', module: 'recipes' },
  { route: '/meals',    labelKey: 'nav.meals',    icon: 'utensils'      },
  { route: '/recipes',  labelKey: 'nav.recipes',  icon: 'book-text'     },
  { route: '/shopping', labelKey: 'nav.shopping', icon: 'shopping-cart' },
  { route: '/pantry',   labelKey: 'nav.pantry',   icon: 'archive'       },
].filter(({ route, module }) => !window.yuvomi?.isModuleDisabled(module ?? route.slice(1)));

export function getLastKitchenRoute() {
  try {
    const stored = sessionStorage.getItem(KITCHEN_STORAGE_KEY);
    if (KITCHEN_ROUTES.includes(stored) && !window.yuvomi?.isModuleDisabled(stored.slice(1))) {
      return stored;
    }
  } catch { /* ignore */ }
  if (!window.yuvomi?.isModuleDisabled('recipes')) return '/sprint'; // fork: Kitchen opens on the sprint
  const first = ['meals', 'recipes', 'shopping', 'pantry'].find((m) => !window.yuvomi?.isModuleDisabled(m));
  return first ? `/${first}` : '/meals';
}

export function isKitchenRoute(path) {
  return KITCHEN_ROUTES.includes(path);
}

export function isKitchenModule(mod) {
  return !!mod && KITCHEN_MODULES.includes(mod);
}

// --------------------------------------------------------
// Kreislauf-Zustand in der Leiste
// --------------------------------------------------------

/**
 * Die Tab-Leiste trägt den Zustand der Nachbar-Stationen.
 *
 * WARUM: Der Kreislauf planen → kochen → einkaufen → lagern ist die Produktidee
 * dieses Moduls, und erzählt wurde er ausschließlich in den vier
 * Leerzustands-Hinweisen. Mit dem ersten Datensatz verschwand er, und übrig blieben
 * vier Schubladen (Critique 2026-07-30, P1). Mit „Einkaufen 12" neben „Vorrat 8"
 * ist der nächste Schritt immer sichtbar.
 *
 * WARUM REZEPTE UND MAHLZEITEN KEINS BEKOMMEN: ein Badge sagt „dort wartet
 * etwas". Eine Rezeptsammlung hat keinen offenen Zustand - „6 Rezepte" wäre eine
 * Bestandszahl, keine Aufforderung.
 *
 * Der Essensplan hatte eins („{{count}} freie Mahlzeiten diese Woche") und es
 * zählte das Gegenteil: nicht was wartet, sondern was fehlt, gemessen an einem
 * Maximum, das niemand füllen will. Sichtbare Mahlzeitentypen × 7 Tage minus die
 * belegten Slots - bei leerer Woche und vier Typen also 28, die lauteste Zahl in
 * der Leiste, ausgerechnet für den Zustand „nichts geplant". Dazu zählte es Tage
 * mit, die schon vorbei waren: freitags stand das Frühstück vom Montag in der
 * Zahl, und das lässt sich nicht mehr planen. Eine Aufforderung, die
 * Unerreichbares mitzählt und die Null nie erreicht, ist keine. Die freien Slots
 * auf der Seite selbst erzählen es vollständiger.
 *
 * Übrig bleiben die zwei Stationen, die wirklich einen offenen Vorrat haben:
 * offene Artikel auf der Einkaufsliste, Vorratsartikel mit einer Frist.
 *
 * WARUM DER AKTIVE TAB KEIN BADGE TRÄGT: das Badge sagt „dort wartet etwas". Auf dem
 * Tab, auf dem man steht, sagt die Seite das vollständiger - die Einkaufsliste hat
 * ihre Zähler-Chips pro Liste, der Vorrat seine Filter-Chips („Abgelaufen 2",
 * „Fast leer 8"), der Essensplan zeigt die freien Slots als leere Kacheln.
 *
 * Das ist nicht nur Redundanzvermeidung, es löst ein Problem: eine Zahl auf dem
 * aktiven Tab müsste nach JEDER Mutation der eigenen Seite nachgezogen werden -
 * abhaken, löschen, Menge ändern, Mahlzeit anlegen. Entweder man verdrahtet
 * zwanzig Aufrufstellen oder man zeigt eine veraltete Zahl direkt neben der
 * korrekten. Der inaktive Tab hat dieses Problem nicht: seine Zahl kann sich nur
 * durch einen Transfer ändern, und die vier Transfers rufen refreshKitchenBadges()
 * selbst auf.
 */
// Das `aria-label` ERSETZT den Namen des Tabs, es ergänzt ihn nicht. Deshalb wird
// der Tabname vorangestellt und die Locale-Keys tragen nur das Zustandsfragment -
// ohne das hörte ein Screenreader „12 offene Artikel" und wüsste nicht, wohin der
// Knopf führt.
const BADGES = [
  {
    route: '/shopping',
    pick: (d) => d.shopping?.open ?? 0,
    label: (count) => `${t('nav.shopping')}: ${t('nav.shoppingOpen', { count })}`,
  },
  {
    route: '/pantry',
    pick: (d) => d.pantry?.attention ?? 0,
    // Der einzige Ton-Ausschlag: abgelaufene und fast leere Artikel sind das
    // einzige Küchen-Signal mit einer Frist.
    tone: 'warning',
    label: (count) => `${t('nav.pantry')}: ${t('nav.pantryAttention', { count })}`,
  },
];

/** Aktuelle Leiste; der Zustand wird nachgeladen, nachdem sie schon steht. */
let _bar = null;
let _activeRoute = null;
let _refreshTimer = null;

async function loadBadges() {
  if (!_bar?.isConnected) return;
  try {
    // `today` kommt vom Client: „abgelaufen" hängt am lokalen Kalendertag, und der
    // Server rechnet in UTC (siehe server/routes/kitchen.js).
    const res = await api.get(`/kitchen/summary?today=${encodeURIComponent(toLocalDateKey())}`);
    const data = res.data ?? {};
    if (!_bar?.isConnected) return;
    for (const { route, pick, label, tone } of BADGES) {
      const count = route === _activeRoute ? 0 : Number(pick(data)) || 0;
      setSubTabBadge(_bar, route, count > 0 ? { count, tone, label: label(count) } : null);
    }
    // Die Zahlen machen die Leiste breiter (je 22px gemessen). Bei 320px läuft sie
    // damit über, und der aktive Tab - beim Rendern korrekt eingescrollt - konnte
    // danach teilweise außerhalb liegen.
    scrollActiveSubTabIntoView(_bar);
  } catch {
    // Ein fehlender Zustand ist kein Fehler, den der Nutzer sehen muss: die Leiste
    // navigiert weiter, sie erzählt nur weniger. Genau wie vor diesem Zusatz.
  }
}

/**
 * Lädt die Zahlen neu. Debounced, weil die aufrufenden Renderer in Serie feuern
 * (ein Abhaken löst in der Einkaufsliste mehrere Teil-Renders aus).
 *
 * Aufrufer sind die VIER TRANSFERS - nicht jede Mutation: nur ein Transfer ändert
 * die Zahl eines anderen Tabs, und nur die wird angezeigt (der aktive Tab trägt
 * kein Badge, siehe oben). Alles andere deckt der Abruf beim Seitenwechsel ab.
 */
export function refreshKitchenBadges() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(loadBadges, 200);
}

export function renderKitchenTabsBar(container, activeRoute) {
  container.classList.add('has-kitchen-tabs');
  _activeRoute = activeRoute;

  _bar = renderSubTabs(container, {
    // Zielorte, keine Sichten: die vier Küchen-Routen sind vier eigenständige
    // Module (eigener `module:`-Wert in router.js, eigene Seitendatei, einzeln
    // abschaltbar). Die Leiste wird damit zur Navigation aus echten Links -
    // cmd-Klick öffnet den Vorrat im neuen Tab, wie überall sonst in der Shell.
    semantics: 'nav',
    tabs: TABS().map(({ route, labelKey, label, icon }) => ({ id: route, label: label ?? t(labelKey), icon })),
    activeId: activeRoute,
    storageKey: KITCHEN_STORAGE_KEY,
    extraClass: 'kitchen-tabs-bar',
    ariaLabel: t('nav.kitchen'),
    title: t('nav.kitchen'),
    // DER ABSENDER DER KÜCHE STEHT EINMAL, UND ZWAR HIER. Die vier Küchen-Köpfe
    // bekommen keinen: sie teilen EINEN Tint, weil sie EIN Raum sind - vier
    // Siegel wiederholten denselben Absender bei jedem Tabwechsel, und zwei der
    // vier Köpfe (Rezepte, Vorrat) tragen gar keinen Seitentitel, hätten also
    // einen Absender ohne Brief. Das Besteck ist dasselbe Zeichen, das die
    // Bottom-Nav für „Küche" führt (kitchenNavButtonEl in router.js).
    sealIcon: () => moduleIconEl(MODULE_ICON.kitchen),
    insertPosition: 'afterbegin',
    onChange: (route) => window.yuvomi?.navigate(route),
  });

  refreshKitchenBadges();
  return _bar;
}
