import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ZoomInfoAccountConfiguratorRpc,
  ZoomInfoAccountConfiguratorValues,
} from "./account-configurator-types";

// The whole-account resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms which account is being connected and
// signals readiness. The sandboxed runtime has no effect hooks, so we render static text and rely
// on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="アカウント全体のアクセス"
        description="このバインディングにより、接続された ZoomInfo アカウントへのアクセスが許可されます: ルックアップ、会社/連絡先/インテント/スクープ/ニュース検索、レコードの強化 (クレジットを消費します)、推奨事項、およびアカウント インテリジェンスはすべて、アカウントの ZoomInfo 資格に依存します。">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ZoomInfoAccountConfiguratorRpc, ZoomInfoAccountConfiguratorValues>;
