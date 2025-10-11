FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y sudo && \
    apt-get install -y w3m && \
    apt-get install -y apache2 && \
    a2enmod rewrite && \
    a2enmod socache_shmcb && \
    apt-get clean && \
    apt-get autoclean

RUN rm -f /var/www/html/index.html
COPY . /var/www/html/

RUN rm -f /var/www/html/apache2.conf

RUN echo "*               soft    nofile          8192" >> /etc/security/limits.conf
RUN echo "*               hard    nofile          8192" >> /etc/security/limits.conf

COPY ./apache2.conf /etc/apache2/apache2.conf
RUN rm -f ./apache2.conf

STOPSIGNAL SIGWINCH

EXPOSE 80

CMD sudo apache2ctl -D FOREGROUND
