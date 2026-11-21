
## Execução 2026-11-14 18:40:43 -03

- conta: `794399909334`  região: `us-east-1`  ARN: `arn:aws:sts::794399909334:assumed-role/voclabs/user5696546=emanuelrodrigues112358@gmail.com`

| # | data | verificação | estado | detalhe |
| --- | --- | --- | --- | --- |
| K1 | 2026-11-14 | credenciais validas (sts get-caller-identity) | OK | role de sessao = `voclabs` |
| K2 | 2026-11-14 | regiao efetiva | OK | us-east-1 |
| K3 | 2026-11-14 | criar key pair (CreateKeyPair) | OK | permitido |
| K3b | 2026-11-14 | importar key pair (ImportKeyPair) | OK | permitido |
| K6 | 2026-11-14 | LabRole existe | OK | arn:aws:iam::794399909334:role/LabRole |
| K7 | 2026-11-14 | LabInstanceProfile existe | OK | nome exato confirmado |
| K10 | 2026-11-14 | ECR liberado (get-login-password) | OK | token obtido (nao exibido) |
| K11 | 2026-11-14 | S3: criar + versionar bucket | OK | ok (removido no fim) |
| K14 | 2026-11-14 | RDS: DB subnet group disponivel | INCONCLUSIVO | nenhum subnet group (Opcao 2 fica em risco) |
| K4 | 2026-11-14 | tipos de instancia na regiao | OK | t3.small=sim t3.micro=sim |
| K5 | 2026-11-14 | cota de vCPU on-demand | INCONCLUSIVO | service-quotas negado |
| K9 | 2026-11-14 | OIDC provider para GitHub Actions | N/A | nao testado (rode com --com-iam) |

> **Correções aplicadas depois desta execução** (mantidas aqui como nota, sem reescrever
> os números originais):
>
> 1. **K1**: a versão do script usada imprimiu `LabRole` como detalhe, mas o ARN real é
>    `assumed-role/voclabs/...`. A role de sessão do Vocareum chama-se **`voclabs`**; `LabRole`
>    é a role de serviço usada por `LabInstanceProfile`. Ver `docs/02` §4.
> 2. **K7** respondeu apenas que o instance profile existe. Falta confirmar **qual role** ele
>    contém:
>    ```bash
>    aws iam get-instance-profile --instance-profile-name LabInstanceProfile \
>      --query 'InstanceProfile.Roles[].RoleName' --output text
>    ```
>    Esperado: `LabRole`. Se retornar outra coisa, é esse nome que o Terraform usa em
>    `iam_instance_profile`.
> 3. **K5** (`service-quotas` negado) não importa para a Opção 1: só seria usado para
>    Auto Scaling/ALB. **K14** (sem DB subnet group) encerra a Opção 2 salvo criação manual —
>    a arquitetura recomendada não depende de RDS.

---

## F3.1 — sessão validada e bucket de state criado (2026-11-20)

Executado pelo dono, na sessão de laboratório iniciada em 2026-11-20T08:04:16-0800.

```text
Terraform v1.17.2  (linux_amd64)          # required_version = ">= 1.10": atendido
conta    794399909334
região   us-east-1                        # fixa pelo lab
ARN      arn:aws:sts::794399909334:assumed-role/voclabs/user5696546=...
bucket   bcc-cloud-tfstate-794399909334   # criado por scripts/bootstrap-state.sh
  versionamento ........ Enabled
  criptografia ......... AES256 (SSE-S3)
  bloqueio público ..... BlockPublicAcls/IgnorePublicAcls/BlockPublicPolicy/RestrictPublicBuckets
key pairs na conta ... vockey             # projeto2 NÃO existe: o Terraform usa vockey
```

K7 respondido: o `apply` da F3.4 criou a instância com `LabInstanceProfile` e ela subiu
com o perfil anexado — o instance profile contém `LabRole`, como esperado.

O bucket de state sobreviveu ao `terraform destroy` do gate F3.7, que é o desenho:
ele é o registro do que o Terraform criou e não pertence ao state que guarda.
