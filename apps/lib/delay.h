#ifndef PLATFORM_DELAY_H
#define PLATFORM_DELAY_H

#include "syscall.h"

void delay(unsigned long ms)
{
    unsigned long start = sys_time();
    while (sys_time() - start < ms);
}

void delay_us(unsigned long us)
{
    delay((us + 999) / 1000);
}

#endif
