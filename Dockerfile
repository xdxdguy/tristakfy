# Cloud (always-on) server: SoundCloud only. YouTube is turned off because it blocks cloud IP addresses.
#   docker build -t tristakfy .
#   docker run -d -p 8000:8000 -e ACCESS_KEY=choose-a-long-random-key tristakfy
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server server
COPY web web
# HOST=0.0.0.0: a cloud server has to answer everyone (protect it with ACCESS_KEY)
ENV ENABLE_YOUTUBE=0 ENABLE_SOUNDCLOUD=1 PORT=8000 HOST=0.0.0.0
EXPOSE 8000
CMD ["python", "server/app.py"]
