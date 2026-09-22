# Enclave: разработка на Modal

Modal сохранён как профиль обычного GPU-инференса. Текущий провайдер GPU TEE — NEAR, для него реализован отдельный [проверяемый профиль](near-development.md). Локальный шлюз по-прежнему использует `TEE_MODE=dev`, поэтому запрет production сохраняется.

## Что запускается

- Modal App: `enclave-inference-dev`.
- Модель: `Qwen/Qwen2.5-3B-Instruct`, закреплённая ревизия в `infra/modal/runtime.py`.
- vLLM 0.29.0: официальный wheel CUDA 12.9 закреплён по SHA-256. При сборке проверяются CUDA PyTorch, нативные библиотеки и CLI-флаги. Обычный wheel этой версии из PyPI использует CUDA 13.
- Один NVIDIA L4, максимум один контейнер, минимум ноль; окно простоя для автоматической остановки — 60 секунд.
- Не более двух одновременно обрабатываемых запросов; контекст до 4096 токенов.
- OpenAI-compatible API; Bearer-авторизация на всех HTTP-маршрутах. Внешний доступ разрешён только к health, models и completions; служебные маршруты закрыты.
- Логирование запросов/ответов и снимки GPU-памяти отключены. Публичные веса загружаются при сборке образа, без `HF_TOKEN`.

Scale-to-zero уменьшает простой, но не устанавливает денежный лимит: сборка, запуск, активный GPU и прочие ресурсы тарифицируются по условиям Modal. Лимит расходов можно настроить отдельно в кабинете. Стенд не обеспечивает защиту данных от администратора хоста.

У выбранной 3B-модели лицензия `qwen-research`; перед коммерческим использованием нужно проверить условия модели. Этот профиль подготовлен для разработки и тестов.

## Установка и вход

Из корня репозитория бэкенда в PowerShell:

```powershell
python -m venv infra/modal/.venv
.\infra\modal\.venv\Scripts\python.exe -m pip install -r infra/modal/requirements.txt
.\infra\modal\.venv\Scripts\python.exe -X utf8 -m modal setup
```

Последняя команда открывает авторизацию в браузере. Если среда уже создана и вход выполнен, повторять их не требуется. Modal SDK установлен в отдельной виртуальной среде; vLLM устанавливается только в облачный образ.

## Как создать Secret

Здесь два разных типа секрета:

| Назначение | Где используется |
|---|---|
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Авторизация CLI в аккаунте Modal. Выдаются при `modal setup`; не передаются gateway и модели. |
| Secret `enclave-inference`, поле `INFERENCE_API_KEY` | Случайный ключ доступа gateway к нашему vLLM endpoint. |

Рекомендуемый вариант создаёт ключ без его вывода в терминал:

```powershell
if (-not (Test-Path -LiteralPath '.env.modal')) { python scripts/modal-secret.py init }
.\infra\modal\.venv\Scripts\python.exe scripts/modal-secret.py upload
```

`init` создаёт `.env.modal` с новым 256-битным случайным ключом. Файл исключён из Git, существующий файл не перезаписывается. `upload` отправляет в Modal только этот ключ и создаёт Secret `enclave-inference`. Если такой Secret уже существует, команда останавливается: автоматической замены ключа нет. При ошибке сети создание могло уже завершиться — сначала проверьте кабинет.

Через кабинет: откройте **Secrets → Create new secret → Custom**, укажите имя **`enclave-inference`**, добавьте поле **`INFERENCE_API_KEY`** и значение из одноимённой строки локального `.env.modal`. Оба значения должны совпадать. Для выделенной среды Modal передайте `--environment <имя>` в `upload` и используйте ту же среду при deploy.

## Развёртывание и проверка

```powershell
.\infra\modal\.venv\Scripts\python.exe -X utf8 -m modal deploy infra/modal/app.py
```

Команда собирает образ и публикует endpoint. Скопируйте напечатанный HTTPS URL, добавьте `/v1` и сохраните в `.env.modal`:

```dotenv
INFERENCE_BASE_URL=https://АДРЕС-ИЗ-MODAL/v1
INFERENCE_HEALTH_PATH=/health
```

Это пример формата: адрес берётся из реального deploy. Остальные настройки уже записаны командой `init`; ключ остаётся прежним. Проверка выполняет один короткий запрос и выводит только статус, размер ответа и время:

```powershell
npm run inference:check
```

Перед отправкой prompt клиент ждёт успешного authenticated `/health` на том же хосте. При холодном запуске безопасный health-запрос повторяется в пределах общего таймаута; запрос с prompt отправляется один раз. Modal ограничивает один HTTP-запрос 150 секундами, поэтому таймаут клиента 300 секунд сам по себе не увеличивает лимит генерации. HTTP-редиректы с prompt или ключом не выполняются.

Для запуска API нужны обычные локальные PostgreSQL, Redis и Anvil из основного README. Начальная сборка и GPU-запуск Modal от локального Docker не зависят:

```powershell
npm run dev:modal
```

Обычный `npm run dev` продолжает использовать стандартный `.env`. Платежи, контракты и БД автоматически в Modal не переносятся. После регистрации новой модели используйте worker и demo из README.

## Регистрация модели в локальном Enclave

Первоначальный deployment содержит только echo-модель. Новый modelHash должен быть зарегистрирован и одобрен для текущего codeHash до оплаченного inference. Не требуется повторно разворачивать контракты или сбрасывать БД.

Помощник `scripts/register-serving-model.ts` обращается к запущенному локальному API, показывает план по умолчанию и изменяет состояние только с `--apply`. Для обхода часового timelock на тестовой сети требуются оба условия: `ALLOW_LOCAL_BOOTSTRAP=true` в окружении API и флаг `--bootstrap`. Это разрешено только для локальной сети 31337. Отозванные модели помощник не восстанавливает.

```powershell
node --env-file=.env.modal --import tsx scripts/register-serving-model.ts
node --env-file=.env.modal --import tsx scripts/register-serving-model.ts --apply --bootstrap
```

Для второго варианта добавьте `ALLOW_LOCAL_BOOTSTRAP=true` в `.env.modal` и перезапустите `npm run dev:modal`. Если используется не стандартный demo-admin, задайте `ENCLAVE_API_KEY` локально. Без bootstrap применяется обычный timelock и повторное одобрение после его окончания.

## Проверки без GPU

```powershell
npm run typecheck
npm test -w @enclave/core
npm test -w @enclave/api
npm run test:modal
```

Полные Postgres/Redis/Anvil интеграционные тесты требуют работающий Docker. Они не вызывают Modal и не расходуют GPU: `npm run test:integration`.

## Текущий GPU TEE-профиль: NEAR

Для NEAR используется `INFERENCE_BACKEND=near-verified`: проверяются CPU/GPU evidence, фактический TLS-ключ и подпись запроса/ответа. Этот профиль уже реализован и проверен живым запросом. Аппаратная изоляция самого шлюза Enclave, его ключей и агентного runtime остаётся отдельной задачей; подключение удалённой модели не помещает локальный `DevCvm` в TEE. Конкретный провайдер для этой изоляции не закреплён, обязательного перехода на Phala нет.

Источники: [Modal Secrets](https://modal.com/docs/guide/secrets), [CLI tokens](https://modal.com/docs/cli/latest/token), [web servers](https://modal.com/docs/reference/modal.web_server), [HTTP timeouts](https://modal.com/docs/guide/webhook-timeouts), [vLLM security](https://docs.vllm.ai/en/stable/usage/security/), [vLLM 0.29.0](https://github.com/vllm-project/vllm/releases/tag/v0.29.0), [лицензия модели](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/aa8e72537993ba99e69dfaafa59ed015b17504d1/LICENSE).
