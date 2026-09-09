import { t } from "@gadgets/configurator-ui";
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
      <Field label={t("gatekeeper-spotify.playlist-configurator-ui.playlist")} description={t("gatekeeper-spotify.playlist-configurator-ui.search_your_playlists_or_paste_a_spotify_playlist_url_or_link")}>
        <Autocomplete
          name="playlistId"
          value={values.playlistId}
          placeholder={t("gatekeeper-spotify.playlist-configurator-ui.search_playlists_or_paste_a_url")}
          loadOptions={query => ui.listPlaylists(query)}
          onChange={playlistId => setValues({ playlistId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SpotifyPlaylistConfiguratorRpc, SpotifyPlaylistConfiguratorValues>;
