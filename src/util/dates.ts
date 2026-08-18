const TZ = 'America/Bogota';

/** ISO date string for "today + offset" in Bogota. Never trust the host clock's TZ. */
export function bogotaDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function formatSpanish(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Anonymous Gregorian computus. */
function easter(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Ley Emiliani: most holidays shift to the following Monday. A static list is wrong. */
function toMonday(d: Date): Date {
  const dow = d.getUTCDay();
  return dow === 1 ? d : addDays(d, (8 - dow) % 7);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function colombianHolidays(year: number): Map<string, string> {
  const e = easter(year);
  const out = new Map<string, string>();
  const fixed: Array<[number, number, string]> = [
    [1, 1, 'Año Nuevo'], [5, 1, 'Día del Trabajo'], [7, 20, 'Independencia'],
    [8, 7, 'Batalla de Boyacá'], [12, 8, 'Inmaculada Concepción'], [12, 25, 'Navidad'],
  ];
  for (const [m, d, name] of fixed) out.set(iso(new Date(Date.UTC(year, m - 1, d))), name);

  const emiliani: Array<[number, number, string]> = [
    [1, 6, 'Reyes Magos'], [3, 19, 'San José'], [6, 29, 'San Pedro y San Pablo'],
    [8, 15, 'Asunción'], [10, 12, 'Día de la Raza'], [11, 1, 'Todos los Santos'],
    [11, 11, 'Independencia de Cartagena'],
  ];
  for (const [m, d, name] of emiliani) {
    out.set(iso(toMonday(new Date(Date.UTC(year, m - 1, d)))), name);
  }

  out.set(iso(addDays(e, -3)), 'Jueves Santo');
  out.set(iso(addDays(e, -2)), 'Viernes Santo');
  out.set(iso(toMonday(addDays(e, 39))), 'Ascensión');
  out.set(iso(toMonday(addDays(e, 60))), 'Corpus Christi');
  out.set(iso(toMonday(addDays(e, 68))), 'Sagrado Corazón');

  return out;
}

export function isHoliday(isoDate: string): string | null {
  return colombianHolidays(Number(isoDate.slice(0, 4))).get(isoDate) ?? null;
}
