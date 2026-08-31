import { render } from "preact";

import { App } from "./app";
import { installI18n } from "./lib/i18n";
import "./styles.css";

installI18n();
render(<App />, document.getElementById("app")!);
