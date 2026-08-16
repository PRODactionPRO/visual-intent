import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

function App() {
  const [message, setMessage] = useState("No local action yet");

  return (
    <main>
      <header className="nav">
        <a className="logo" href="#top" aria-label="Northstar home">
          Northstar
        </a>
        <nav aria-label="Primary navigation">
          <a href="#work">Work</a>
          <a href="#process">Process</a>
          <a href="#contact">Contact</a>
        </nav>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">Independent product studio</p>
          <h1>
            Small teams.
            <br />
            Clear products.
          </h1>
          <p className="lede">
            We turn uncertain product ideas into focused digital tools people
            can understand and use.
          </p>
          <button
            data-testid="hero-cta"
            onClick={() => setMessage("Demo button clicked")}
          >
            Start a conversation
          </button>
          <p className="status" aria-live="polite">
            {message}
          </p>
        </div>
        <aside aria-label="Selected case study">
          <span>Case 04</span>
          <strong>Making a complex planning tool feel calm.</strong>
          <div className="metric">
            <b>42%</b>
            <small>faster first result</small>
          </div>
        </aside>
      </section>

      <section className="work" id="work">
        <article>
          <span>01 / Discover</span>
          <h2>Find the useful problem.</h2>
          <p>
            Interview, map constraints, and agree on the smallest outcome worth
            shipping.
          </p>
        </article>
        <article>
          <span>02 / Shape</span>
          <h2>Make decisions visible.</h2>
          <p>
            Prototype the risky interactions before engineering turns
            assumptions into cost.
          </p>
        </article>
        <article>
          <span>03 / Deliver</span>
          <h2>Build for real feedback.</h2>
          <p>
            Release a narrow working slice and learn from actual behavior, not
            presentation theatre.
          </p>
        </article>
      </section>

      <footer id="contact">
        <span>Visual Intent example surface</span>
        <span>Local development only</span>
      </footer>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
