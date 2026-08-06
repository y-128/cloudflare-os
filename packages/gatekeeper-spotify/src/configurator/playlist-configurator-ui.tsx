import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SpotifyPlaylistConfiguratorRpc,
  SpotifyPlaylistConfiguratorValues,
} from "./playlist-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.playlistId === "string" && values.playlistId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://open.spotify.com/playlist/${values.playlistId}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="プレイリスト" description="プレイリストを検索するか、Spotify プレイリストの URL またはリンクを貼り付けます。">
        <Autocomplete
          name="playlistId"
          value={values.playlistId}
          placeholder="プレイリストを検索またはURLを貼り付け…"
          loadOptions={query => ui.listPlaylists(query)}
          onChange={playlistId => setValues({ playlistId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SpotifyPlaylistConfiguratorRpc, SpotifyPlaylistConfiguratorValues>;
