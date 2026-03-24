# Google Indexing Notifier — Serverless na AWS

Automatyczne powiadamianie Google o nowych/zmienionych stronach po każdym deployu.
Jedno rozwiązanie dla WSZYSTKICH domen.

## Co robi

Po każdym `deploy.sh`:
1. **Ping sitemap** — `curl` do Google (instant, bez auth)
2. **Diff sitemapy** — Lambda porównuje aktualną sitemapę z poprzednią (DynamoDB)
3. **Google Indexing API** — nowe URL-e → `URL_UPDATED`, usunięte → `URL_DELETED`
4. **Search Console API** — submit sitemapy
5. **Zapis stanu** — aktualne URL-e zapisane w DynamoDB na następny diff

## Koszt: $0.00/miesiąc

- Lambda: free tier (1M req/mies, a używasz ~30-50)
- DynamoDB: free tier (25 RCU/WCU on-demand)
- SSM Parameter Store: free (standard params)
- Google APIs: free (Indexing API limit: 200 URL/dzień/property)

## Wymagania (już spełnione)

- [x] Google Cloud — Service Account z kluczem JSON
- [x] Google Cloud — Indexing API włączone
- [x] Google Search Console — SA dodany jako Właściciel
- [x] AWS CLI skonfigurowane

## Instalacja (jednorazowa)

```bash
# 1. Skopiuj pliki do katalogu dowolnej domeny (np. praca-magisterska.pl)
#    lub trzymaj osobno — skrypty są niezależne od projektu

# 2. Deploy infrastruktury (podaj ścieżkę do JSON z Google Cloud)
chmod +x deploy-google-indexing.sh
./deploy-google-indexing.sh /sciezka/do/service-account-key.json

# 3. Skopiuj aws-lambda/google-indexing/ do tego samego katalogu co skrypt
#    (skrypt szuka aws-lambda/google-indexing/ względem siebie)
```

## Użycie

### W deploy.sh (automatycznie po każdym deployu)

Dodaj na końcu swojego `deploy.sh`:

```bash
# Google Indexing notification
echo "🔍 Notifying Google..."
curl -s "https://www.google.com/ping?sitemap=https://www.TWOJA-DOMENA.pl/sitemap-index.xml" > /dev/null
aws lambda invoke \
  --function-name google-indexing-notifier \
  --payload '{"siteUrl":"https://www.TWOJA-DOMENA.pl"}' \
  --cli-binary-format raw-in-base64-out \
  --region eu-central-1 /tmp/indexing-result.json > /dev/null 2>&1
echo "  ✅ Google notified"
```

### Bulk index (jednorazowy — submit wszystkich URL-i)

```bash
chmod +x bulk-index.sh
./bulk-index.sh https://www.praca-magisterska.pl
./bulk-index.sh https://www.licencjackie.pl
./bulk-index.sh https://www.prace-magisterskie.pl
# ... itd. dla każdej domeny
```

### Ręczne wywołanie

```bash
aws lambda invoke \
  --function-name google-indexing-notifier \
  --payload '{"siteUrl":"https://www.praca-magisterska.pl"}' \
  --cli-binary-format raw-in-base64-out \
  --region eu-central-1 /dev/stdout
```

## Dodawanie nowych domen

1. Dodaj Service Account jako Właściciela w Google Search Console nowej domeny
2. Dodaj 3 linijki do `deploy.sh` tej domeny (curl ping + lambda invoke)
3. Opcjonalnie: `./bulk-index.sh https://www.nowa-domena.pl`

Lambda, DynamoDB, SSM — wszystko wspólne, nie trzeba nic nowego stawiać.

## Struktura plików

```
google-indexing/
├── aws-lambda/
│   └── google-indexing/
│       ├── index.mjs          # Lambda handler
│       └── package.json       # Dependencies
├── deploy-google-indexing.sh   # Jednorazowy deploy infrastruktury
├── deploy.sh                   # Przykład deploy.sh z integracją
├── bulk-index.sh               # Jednorazowy bulk submit
└── README.md                   # Ten plik
```

## Troubleshooting

**Lambda zwraca 403 od Google API**
→ Sprawdź czy SA jest dodany jako Właściciel (nie Pełny) w Search Console

**"Indexing API has not been used in project"**
→ Wejdź na console.cloud.google.com → APIs & Services → Enable "Web Search Indexing API"

**Brak nowych URL-i w diffie**
→ Przy pierwszym uruchomieniu DynamoDB jest pusta, więc WSZYSTKIE URL-e będą "nowe"
→ Przy kolejnych: nowe URL-e pojawią się tylko gdy sitemapa się zmieni

**Sprawdzenie stanu DynamoDB**
```bash
aws dynamodb get-item \
  --table-name sitemap-url-tracker \
  --key '{"domain":{"S":"www.praca-magisterska.pl"}}' \
  --region eu-central-1
```
