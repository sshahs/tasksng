import { useEffect, useState } from "react";

/** Changes when the calendar day changes so "Today" views roll over at midnight. */
export function useDayKey(): string {
  const [day, setDay] = useState(() => new Date().toDateString());
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = new Date().toDateString();
      setDay((d) => (d === now ? d : now));
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return day;
}
