//! Telnet (RFC 854) with NAWS / TTYPE / ECHO / SGA / BINARY option handling,
//! plus a "raw" TCP mode without any negotiation.

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::{ConnCmd, Ctx};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const OPT_BINARY: u8 = 0;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Data,
    Iac,
    Opt(u8),
    Sb,
    SbIac,
}

pub struct Telnet {
    state: State,
    sb: Vec<u8>,
    /// Options we perform (answered WILL to the server's DO).
    local: [bool; 256],
    /// Options the server performs (answered DO to the server's WILL).
    remote: [bool; 256],
    term: String,
    cols: u16,
    rows: u16,
}

impl Telnet {
    pub fn new(term: &str, cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sb: Vec::new(),
            local: [false; 256],
            remote: [false; 256],
            term: term.to_uppercase(),
            cols,
            rows,
        }
    }

    /// Options we offer right after connecting.
    pub fn initial(&mut self) -> Vec<u8> {
        self.local[OPT_NAWS as usize] = true;
        self.local[OPT_TTYPE as usize] = true;
        self.remote[OPT_SGA as usize] = true;
        vec![IAC, WILL, OPT_NAWS, IAC, WILL, OPT_TTYPE, IAC, DO, OPT_SGA]
    }

    pub fn naws(&self) -> Vec<u8> {
        let mut v = vec![IAC, SB, OPT_NAWS];
        for b in self.cols.to_be_bytes().into_iter().chain(self.rows.to_be_bytes()) {
            v.push(b);
            if b == IAC {
                v.push(IAC);
            }
        }
        v.extend_from_slice(&[IAC, SE]);
        v
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Option<Vec<u8>> {
        self.cols = cols;
        self.rows = rows;
        self.local[OPT_NAWS as usize].then(|| self.naws())
    }

    pub fn binary_out(&self) -> bool {
        self.local[OPT_BINARY as usize]
    }

    /// Splits incoming bytes into terminal data and negotiation replies.
    pub fn feed(&mut self, input: &[u8], data: &mut Vec<u8>, reply: &mut Vec<u8>) {
        for &b in input {
            self.state = match self.state {
                State::Data if b == IAC => State::Iac,
                State::Data => {
                    data.push(b);
                    State::Data
                }
                State::Iac => match b {
                    IAC => {
                        data.push(IAC);
                        State::Data
                    }
                    WILL | WONT | DO | DONT => State::Opt(b),
                    SB => {
                        self.sb.clear();
                        State::Sb
                    }
                    _ => State::Data, // NOP, GA, AYT, ... ignored
                },
                State::Opt(verb) => {
                    self.negotiate(verb, b, reply);
                    State::Data
                }
                State::Sb if b == IAC => State::SbIac,
                State::Sb => {
                    if self.sb.len() < 4096 {
                        self.sb.push(b);
                    }
                    State::Sb
                }
                State::SbIac => match b {
                    SE => {
                        self.subnegotiation(reply);
                        State::Data
                    }
                    IAC => {
                        self.sb.push(IAC);
                        State::Sb
                    }
                    _ => State::Data,
                },
            };
        }
    }

    fn negotiate(&mut self, verb: u8, opt: u8, reply: &mut Vec<u8>) {
        let i = opt as usize;
        match verb {
            DO => {
                let supported = matches!(opt, OPT_NAWS | OPT_TTYPE | OPT_BINARY | OPT_SGA);
                if supported {
                    if !self.local[i] {
                        self.local[i] = true;
                        reply.extend_from_slice(&[IAC, WILL, opt]);
                    }
                    if opt == OPT_NAWS {
                        reply.extend_from_slice(&self.naws());
                    }
                } else {
                    reply.extend_from_slice(&[IAC, WONT, opt]);
                }
            }
            DONT if self.local[i] => {
                self.local[i] = false;
                reply.extend_from_slice(&[IAC, WONT, opt]);
            }
            WILL => {
                let supported = matches!(opt, OPT_ECHO | OPT_SGA | OPT_BINARY);
                if supported {
                    if !self.remote[i] {
                        self.remote[i] = true;
                        reply.extend_from_slice(&[IAC, DO, opt]);
                    }
                } else {
                    reply.extend_from_slice(&[IAC, DONT, opt]);
                }
            }
            WONT if self.remote[i] => {
                self.remote[i] = false;
                reply.extend_from_slice(&[IAC, DONT, opt]);
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        // TTYPE SEND -> TTYPE IS <terminal>
        if self.sb.first() == Some(&OPT_TTYPE) && self.sb.get(1) == Some(&1) {
            reply.extend_from_slice(&[IAC, SB, OPT_TTYPE, 0]);
            reply.extend_from_slice(self.term.as_bytes());
            reply.extend_from_slice(&[IAC, SE]);
        }
    }
}

/// Escape IAC and translate the Enter key for the wire.
fn encode_input(input: &[u8], telnet: bool, binary: bool, crlf: bool, out: &mut Vec<u8>) {
    for &b in input {
        match b {
            IAC if telnet => out.extend_from_slice(&[IAC, IAC]),
            b'\r' if (telnet && !binary) || crlf => out.extend_from_slice(b"\r\n"),
            _ => out.push(b),
        }
    }
}

pub async fn run(mut ctx: Ctx, telnet: bool) -> Result<String> {
    let host = ctx.session.host.trim().to_string();
    if host.is_empty() {
        return Err(anyhow!("no host name configured"));
    }
    let port = ctx.session.effective_port();
    if port == 0 {
        return Err(anyhow!("no port configured"));
    }
    ctx.status(format!("Connecting to {host}:{port} ..."));
    let tcp = tokio::time::timeout(ctx.connect_timeout(), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| anyhow!("connection to {host}:{port} timed out"))?
        .with_context(|| format!("cannot connect to {host}:{port}"))?;
    let _ = tcp.set_nodelay(true);
    let (mut rd, mut wr) = tcp.into_split();

    let mut proto = Telnet::new(&ctx.settings.term_type, ctx.cols, ctx.rows);
    if telnet {
        wr.write_all(&proto.initial()).await?;
    }
    ctx.connected();

    let crlf = ctx.session.crlf;
    let mut buf = vec![0u8; 32 * 1024];
    let mut data = Vec::with_capacity(32 * 1024);
    let mut reply = Vec::new();
    let mut outbuf = Vec::new();
    loop {
        tokio::select! {
            n = rd.read(&mut buf) => {
                let n = n.context("connection error")?;
                if n == 0 {
                    return Ok("Connection closed by remote host".into());
                }
                if telnet {
                    data.clear();
                    reply.clear();
                    proto.feed(&buf[..n], &mut data, &mut reply);
                    ctx.out.write(&data);
                    if !reply.is_empty() {
                        wr.write_all(&reply).await?;
                    }
                } else {
                    ctx.out.write(&buf[..n]);
                }
            }
            cmd = ctx.rx.recv() => match cmd {
                Some(ConnCmd::Data(d)) => {
                    outbuf.clear();
                    encode_input(&d, telnet, proto.binary_out(), crlf, &mut outbuf);
                    wr.write_all(&outbuf).await?;
                }
                Some(ConnCmd::Resize { cols, rows }) => {
                    if let Some(msg) = proto.resize(cols, rows) {
                        if telnet {
                            wr.write_all(&msg).await?;
                        }
                    }
                }
                Some(ConnCmd::Close) | None => {
                    let _ = wr.shutdown().await;
                    return Ok("Disconnected".into());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_and_data() {
        let mut t = Telnet::new("xterm", 80, 24);
        let mut data = Vec::new();
        let mut reply = Vec::new();
        t.feed(
            &[
                b'h', IAC, DO, OPT_NAWS, b'i', IAC, IAC, IAC, WILL, OPT_ECHO, IAC, DO, 42,
            ],
            &mut data,
            &mut reply,
        );
        assert_eq!(data, vec![b'h', b'i', IAC]);
        assert_eq!(
            reply,
            vec![IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE, IAC, DO, OPT_ECHO, IAC, WONT, 42]
        );
    }

    #[test]
    fn split_sequences_and_ttype() {
        let mut t = Telnet::new("xterm-256color", 80, 24);
        let (mut data, mut reply) = (Vec::new(), Vec::new());
        t.feed(&[IAC], &mut data, &mut reply);
        t.feed(&[SB, OPT_TTYPE, 1, IAC], &mut data, &mut reply);
        t.feed(&[SE, b'x'], &mut data, &mut reply);
        assert_eq!(data, b"x");
        let mut expected = vec![IAC, SB, OPT_TTYPE, 0];
        expected.extend_from_slice(b"XTERM-256COLOR");
        expected.extend_from_slice(&[IAC, SE]);
        assert_eq!(reply, expected);
    }

    #[test]
    fn naws_escapes_255() {
        let t = Telnet::new("x", 255, 24);
        assert_eq!(t.naws(), vec![IAC, SB, OPT_NAWS, 0, IAC, IAC, 0, 24, IAC, SE]);
    }

    #[test]
    fn input_encoding() {
        let mut out = Vec::new();
        encode_input(&[b'a', b'\r', IAC], true, false, false, &mut out);
        assert_eq!(out, vec![b'a', b'\r', b'\n', IAC, IAC]);
        out.clear();
        encode_input(&[b'\r', IAC], false, false, false, &mut out);
        assert_eq!(out, vec![b'\r', IAC]);
    }
}
