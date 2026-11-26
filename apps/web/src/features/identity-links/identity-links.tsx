import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import type { paths } from "@mns-suporte/sdk";
import { apiClient, ApiFailure, unwrap } from "../../api-client.js";
import { Button, TextField } from "../../components.js";
import "./identity-links.css";

const route = getRouteApi("/ti/vinculos");
const linksKey = ["whatsapp-identity-links"] as const;
type LinkRecord =
  paths["/admin/whatsapp/identity-links"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
const statusLabels = {
  active: "Ativo",
  expired: "Expirado",
  revoked: "Revogado",
} as const;
const formatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

function readFailure(error: unknown) {
  if (!(error instanceof ApiFailure))
    return "Não foi possível consultar os vínculos.";
  if (error.status === 401) return "O token está inválido ou expirado.";
  if (error.status === 403)
    return "Seu acesso não permite consultar os vínculos.";
  if (error.status === 503) return "A autenticação da TI está indisponível.";
  return "Não foi possível consultar os vínculos.";
}

function revokeFailure(error: unknown) {
  if (error instanceof ApiFailure && error.status === 403)
    return "Seu acesso não permite revogar vínculos.";
  if (error instanceof ApiFailure && error.status === 401)
    return "O token está inválido ou expirado.";
  return "Consulte a lista atual antes de tentar revogar novamente.";
}

export function IdentityLinksPage() {
  const client = useQueryClient();
  const { glpiUserId, after } = route.useSearch();
  const [token, setToken] = useState("");
  const [pendingToken, setPendingToken] = useState("");
  const [sessionVersion, setSessionVersion] = useState(0);

  useEffect(
    () => () => {
      client.removeQueries({ queryKey: linksKey });
    },
    [client],
  );

  function changeToken(value: string) {
    setToken(value);
    setSessionVersion((version) => version + 1);
    client.removeQueries({ queryKey: linksKey });
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Vínculos de WhatsApp</h1>
          <p>
            Consulte os números verificados por usuário do GLPI e revogue um
            vínculo quando necessário.
          </p>
        </div>
      </div>
      <form
        className="panel identity-links-panel identity-links-search"
        aria-label="Acesso da TI"
        onSubmit={(event) => {
          event.preventDefault();
          changeToken(pendingToken.trim());
          setPendingToken("");
        }}
      >
        <TextField
          type="password"
          label="Token de acesso da TI"
          autoComplete="off"
          value={pendingToken}
          onChange={(event) => setPendingToken(event.target.value)}
        />
        <Button type="submit" disabled={!pendingToken.trim()}>
          Usar token
        </Button>
        {token && (
          <Button
            onClick={() => {
              changeToken("");
              setPendingToken("");
            }}
          >
            Encerrar acesso
          </Button>
        )}
      </form>
      <LinkSession
        key={
          sessionVersion + ":" + String(glpiUserId ?? "") + ":" + (after ?? "")
        }
        token={token.trim()}
        glpiUserId={glpiUserId}
        after={after}
      />
    </>
  );
}

function LinkSession({
  token,
  glpiUserId,
  after,
}: {
  token: string;
  glpiUserId?: number;
  after?: string;
}) {
  const [input, setInput] = useState(String(glpiUserId ?? ""));
  const [selected, setSelected] = useState<LinkRecord>();
  const [feedback, setFeedback] = useState("");
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const key = [...linksKey, glpiUserId, after] as const;
  const list = useQuery({
    queryKey: key,
    enabled: !!token && glpiUserId !== undefined,
    queryFn: async ({ signal }) =>
      unwrap(
        await apiClient(token).GET("/admin/whatsapp/identity-links", {
          params: { query: { glpiUserId: glpiUserId!, after } },
          signal,
        }),
      ),
  });
  const revoke = useMutation({
    mutationFn: async (linkId: string) =>
      unwrap(
        await apiClient(token).POST(
          "/admin/whatsapp/identity-links/{linkId}/revoke",
          {
            params: { path: { linkId } },
          },
        ),
      ),
  });

  const page = list.isError ? undefined : list.data;

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = Number(input);
    if (!token || !Number.isSafeInteger(id) || id < 1) return;
    setFeedback("");
    if (glpiUserId === id && !after) void list.refetch();
    else void navigate({ search: { glpiUserId: id } });
  }

  function dropLink() {
    if (!selected || revoke.isPending) return;
    const id = selected.id;
    revoke.mutate(id, {
      onSuccess: () => {
        setSelected(undefined);
        setFeedback("Vínculo revogado.");
        void queryClient.invalidateQueries({ queryKey: linksKey });
      },
      onError: () => setSelected(undefined),
    });
  }

  const id = Number(input);
  return (
    <>
      <form
        className="panel identity-links-panel identity-links-search"
        onSubmit={search}
      >
        <TextField
          label="ID do usuário no GLPI"
          inputMode="numeric"
          pattern="[1-9][0-9]*"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          required
        />
        <Button
          type="submit"
          variant="primary"
          pending={list.isFetching}
          disabled={
            !token || !Number.isSafeInteger(id) || id < 1 || revoke.isPending
          }
        >
          Consultar
        </Button>
      </form>
      {token && glpiUserId !== undefined && (
        <section
          className="panel identity-links-panel"
          aria-labelledby="identity-results"
        >
          <h2 id="identity-results">Vínculos do usuário {glpiUserId}</h2>
          {feedback && <p role="status">{feedback}</p>}
          {list.isPending && <p role="status">Carregando vínculos…</p>}
          {list.isError && <p role="alert">{readFailure(list.error)}</p>}
          {revoke.isError && (
            <div role="alert">
              <p>{revokeFailure(revoke.error)}</p>
              <Button
                onClick={() => {
                  revoke.reset();
                  void list.refetch();
                }}
              >
                Recarregar lista
              </Button>
            </div>
          )}
          {page && page.items.length === 0 && (
            <p className="empty-state">Nenhum vínculo encontrado.</p>
          )}
          {page && page.items.length > 0 && (
            <div className="identity-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">WhatsApp</th>
                    <th scope="col">Situação</th>
                    <th scope="col">Verificado em</th>
                    <th scope="col">Validade</th>
                    <th scope="col">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((link) => (
                    <tr key={link.id}>
                      <th scope="row">
                        {link.phoneLastFour
                          ? "Final " + link.phoneLastFour
                          : "Telefone oculto"}
                        <span className="identity-reference">
                          {link.id.slice(0, 8)}
                        </span>
                      </th>
                      <td>{statusLabels[link.status]}</td>
                      <td>{formatter.format(new Date(link.verifiedAt))}</td>
                      <td>{formatter.format(new Date(link.expiresAt))}</td>
                      <td>
                        {link.status === "active" ? (
                          <Button
                            aria-label={
                              "Revogar vínculo " +
                              (link.phoneLastFour ?? link.id.slice(0, 8))
                            }
                            disabled={revoke.isPending || revoke.isError}
                            onClick={() => {
                              setFeedback("");
                              setSelected(link);
                            }}
                          >
                            Revogar
                          </Button>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selected && (
            <section
              className="identity-revoke"
              aria-label="Confirmar revogação"
            >
              <p>
                Revogar o vínculo{" "}
                {selected.phoneLastFour
                  ? "do número com final " + selected.phoneLastFour
                  : selected.id.slice(0, 8)}
                ? Esse WhatsApp precisará se verificar novamente.
              </p>
              <div className="identity-actions">
                <Button
                  onClick={() => setSelected(undefined)}
                  disabled={revoke.isPending}
                >
                  Cancelar
                </Button>
                <Button
                  variant="primary"
                  pending={revoke.isPending}
                  onClick={dropLink}
                >
                  Confirmar revogação
                </Button>
              </div>
            </section>
          )}
          {(after || page?.next) && (
            <div className="pagination">
              <Button
                disabled={!after || revoke.isPending}
                onClick={() => void navigate({ search: { glpiUserId } })}
              >
                Primeira página
              </Button>
              <Button
                disabled={!page?.next || revoke.isPending}
                onClick={() =>
                  void navigate({
                    search: { glpiUserId, after: page?.next ?? undefined },
                  })
                }
              >
                Próxima página
              </Button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
