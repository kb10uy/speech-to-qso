<section>
    <h2>Voice commands</h2>
    <p class="hint">
        One utterance per PTT press. Speaking a field again overwrites it. Commands can be chained.
        With the Japanese model, say the same words as katakana loanwords (ジュリエット リマ ワン
        …), and 送信, 受信 and 周波数 for sent, received and frequency.
    </p>
    <dl>
        <dt>juliett lima one hotel india sierra</dt>
        <dd>Callsign JL1HIS (“stroke one” or “portable one” → /1, “portable” → /P)</dd>
        <dt>sent five nine · received five seven</dt>
        <dd>RST sent / received (defaults 59)</dd>
        <dt>frequency point nine four</dt>
        <dd>*.940 MHz, nearest to the anchor</dd>
        <dt>frequency two point seven four</dt>
        <dd>*2.740 MHz; “four thirty two point nine four” is fully specified</dd>
        <dt>jcx one zero zero one zero one</dt>
        <dd>JCC/JCG 100101 (also “jcc”, “jcg”)</dd>
        <dt>card requested · card negative</dt>
        <dd>QSL requested on/off</dd>
        <dt>card one way</dt>
        <dd>QSL one way: they send a card and expect none back</dd>
        <dt>mode foxtrot mike</dt>
        <dd>Mode FM (also SSB, CW, FT8, …)</dd>
    </dl>
</section>

<style>
    h2 {
        margin: 1.2rem 0 0.8rem;
    }
    dl {
        display: grid;
        gap: 0.2rem;
    }
    dt {
        font-family: var(--mono);
        margin-top: 0.5rem;
    }
    dd {
        margin: 0;
        color: var(--muted);
        font-size: 0.9rem;
    }
</style>
