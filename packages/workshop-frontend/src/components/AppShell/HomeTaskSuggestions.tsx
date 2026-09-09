import { t, useTranslation } from "@gadgets/i18n";
import { useMemo } from 'react'
import {
  AppWindow,
  ChartLineUp,
  FileText,
  Lightning,
  Presentation,
  type Icon,
} from '@phosphor-icons/react'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

// Formats are advertised by example rather than by a row of "Start with Docs" buttons, so the
// first move isn't "pick a file type". The formats themselves are in the composer's `+` menu.
const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'one-on-one',
    get label() { return t("workshop-frontend.HomeTaskSuggestions.write_a_1_1_pre_read"); },
    get description() { return t("workshop-frontend.HomeTaskSuggestions.a_doc_with_a_snapshot_things_to_inspect_and_one_ask"); },
    icon: FileText,
    get prompt() { return t("workshop-frontend.HomeTaskSuggestions.create_a_document_to_prepare_for_my_next_1_1_with_a_direct_report"); },
  },
  {
    id: 'team-meeting',
    get label() { return t("workshop-frontend.HomeTaskSuggestions.build_a_team_meeting_deck"); },
    get description() { return t("workshop-frontend.HomeTaskSuggestions.slides_with_progress_risks_and_what_needs_a_decision"); },
    icon: Presentation,
    get prompt() { return t("workshop-frontend.HomeTaskSuggestions.create_a_slide_deck_for_my_next_team_meeting_where_things_stand_w"); },
  },
  {
    id: 'insights',
    get label() { return t("workshop-frontend.HomeTaskSuggestions.find_insights_in_my_data"); },
    get description() { return t("workshop-frontend.HomeTaskSuggestions.turn_a_spreadsheet_or_csv_into_trends_and_recommendations"); },
    icon: ChartLineUp,
    get prompt() { return t("workshop-frontend.HomeTaskSuggestions.turn_a_dataset_i_will_share_a_spreadsheet_csv_or_pasted_table_int"); },
  },
  {
    id: 'workflow',
    get label() { return t("workshop-frontend.HomeTaskSuggestions.automate_a_workflow"); },
    get description() { return t("workshop-frontend.HomeTaskSuggestions.trigger_an_agent_when_a_new_email_arrives"); },
    icon: Lightning,
    get prompt() { return t("workshop-frontend.HomeTaskSuggestions.create_an_agent_workflow_that_runs_automatically_when_a_new_email"); },
  },
  {
    id: 'app',
    get label() { return t("workshop-frontend.HomeTaskSuggestions.build_a_quick_tool"); },
    get description() { return t("workshop-frontend.HomeTaskSuggestions.a_small_interactive_app_calculator_or_dashboard"); },
    icon: AppWindow,
    get prompt() { return t("workshop-frontend.HomeTaskSuggestions.build_a_small_interactive_tool_i_can_use_right_here_a_calculator_"); },
  },
]

// One row, shared by every suggestion so the list reads as one kind of offer.
function SuggestionRow({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  useTranslation();
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle transition-colors group-hover:text-kumo-default">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {label}
          </span>
          <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {description}
          </span>
        </span>
      </button>
    </li>
  )
}

// How many of the suggestions above to show at once. The list is longer than the page should be:
// four rows is inspiration, seven is a menu to read. Which three appear is chosen per visit, so the
// ones below the fold still get seen -- and so Home doesn't look like it only does one thing.
const VISIBLE_SUGGESTIONS = 3

function pickSuggestions(): TaskSuggestion[] {
  let shuffled = [...SUGGESTIONS]
  for (let i = shuffled.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, VISIBLE_SUGGESTIONS)
}

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  const { t } = useTranslation();
  // Chosen once per mount: re-rolling on every render would shuffle the list under the pointer.
  const visible = useMemo(pickSuggestions, [])

  return (
    <section aria-label={t("workshop-frontend.HomeTaskSuggestions.example_tasks")} className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        {t("workshop-frontend.HomeTaskSuggestions.get_started")}</h3>
      <ul className="flex flex-col gap-0.5">
        {visible.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            icon={<suggestion.icon size={16} />}
            label={suggestion.label}
            description={suggestion.description}
            onClick={() => onPick(suggestion.prompt)}
          />
        ))}
      </ul>
    </section>
  )
}
