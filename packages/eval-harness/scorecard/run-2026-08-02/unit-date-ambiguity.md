# unit-date-ambiguity

_Safety check passed; normal synthesis below._

### Recorded Facts

- Starting weight on 2026-05-01 was 79.4 kg.
- Baseline goal target weight is 68 kg; app defaults to lb for entries.
- Weight logged 2026-07-13: 172 lb (morning).
- Weight logged 2026-07-14: 172.2 lb (morning).
- Weight logged 2026-07-15: 77.6 kg (morning), with note: 'Weighed at my mom's house on her scale, it's in kg not lb like mine, forgot to convert.'
- Weight logged 2026-07-16: 171.8 lb (morning), with note: 'Back on my home scale (lb) today.'
- Weight logged 2026-07-19: 171.4 lb (morning).
- Sleep logged: 7 hrs (good) on 7/13, 6.8 hrs (fair) on 7/14, 7.1 hrs (good) on 7/15, 7.3 hrs (good) on 7/16, 7.5 hrs (good) on 7/19.
- Swim activity logged on 7/14 (40 min, moderate) and 7/19 (40 min, moderate).
- Hunger levels logged between 4 and 5 across the week.
- Meals logged include oatmeal, toast and eggs, chicken salad, yogurt and granola, and pancakes.
- Note on 7/19 entry: user mentioned an old spreadsheet log dated '03/04/26' with unclear month/day order, but clarified the values shown for this week are current.
- Weekly reflection states adherence was 'high' and mood was 'good', with mood tag 'steady'.
- Reflection explicitly flags the 7/15 entry as being from a kg-based scale, differing from the usual lb scale.
- Derived metrics: 5 of 7 days logged, weight trend from 172 lb (7/13) to 171.4 lb (7/19), a -0.6 lb change; average sleep 7.14 hrs; average hunger level 4.2.

### Observations

- Weight was logged on 5 of 7 days this week.
- Four of the five weight entries were recorded in lb on a consistent home scale; one entry (7/15) was recorded in kg on a different scale.
- The lb-based entries show a small downward trend (172 → 171.4 lb) across the week.
- Sleep was logged every day with 'good' quality on 4 of 5 days and 'fair' on 1 day.
- Swim sessions were logged twice during the week, consistent with the baseline activity pattern of swimming once weekly.
- Hunger levels stayed in a narrow range (4–5) across all logged days.
- The user flagged both a unit mismatch (kg vs lb) and an unrelated date-format ambiguity from an old spreadsheet import.

### Tentative Hypotheses

- The 7/15 kg entry (77.6 kg) may be roughly consistent with the surrounding lb readings once converted, though this can't be confirmed precisely without knowing the exact conversion the user intends to use.
- The mild downward trend in lb-logged weights may reflect typical day-to-day fluctuation rather than a meaningful change, given the short time frame and single differing scale reading.
- Missing logs on 2 of 7 days may simply reflect normal routine variation rather than a change in engagement, especially since adherence was self-reported as high.

### What's Working

- Consistent daily sleep logging with mostly 'good' quality reported.
- Regular swim activity maintained at the baseline frequency (1x/week, occurring twice this week).
- Stable hunger levels throughout the week, suggesting consistent eating patterns.
- High self-reported adherence and steady mood for the week.

### Friction

- Switching between a home scale (lb) and a different scale (kg) introduces inconsistency that complicates tracking a clean weight trend.
- Two days without a logged weight limit the ability to see a fully continuous week-over-week pattern.
- An old spreadsheet import with an ambiguous date format was noted, though the user clarified it doesn't affect this week's data.

### What Should Remain Unchanged

_None._

### Proposed Next Step (experiment)

For the next 7 days, log morning weight using only the home scale in lb each day, and if a different scale is used, note the unit explicitly at the time of entry. This will allow the weekly trend to be compared directly without needing conversion or guesswork about which scale was used.
